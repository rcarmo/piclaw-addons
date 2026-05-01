/**
 * IMAP settings pane — SQLite KV + keychain account manager.
 */
// @ts-nocheck
const API_BASE = '/agent/addons/api/imap';
const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
const html = preactHtm?.html;
const useEffect = preactHtm?.useEffect;
const useMemo = preactHtm?.useMemo;
const useState = preactHtm?.useState;
const HAS_RUNTIME = Boolean(html && useEffect && useMemo && useState);

const ICON = HAS_RUNTIME
  ? html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"></path><path d="m22 8-8.97 6.35a1.8 1.8 0 0 1-2.06 0L2 8"></path></svg>`
  : null;

async function api(path, options = {}) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await resp.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!resp.ok || payload?.ok === false) {
    throw new Error(payload?.error || `${resp.status} ${resp.statusText}`);
  }
  return payload;
}

async function setKeychainSecret(name, secret) {
  const resp = await fetch('/agent/keychain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, secret, type: 'password' }),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Failed to save keychain entry ${name}`);
  }
  return payload;
}

async function deleteKeychainSecret(name) {
  const resp = await fetch('/agent/keychain', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Failed to delete keychain entry ${name}`);
  }
  return payload;
}

function normalizeAccountName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function passwordKeychainName(name) {
  return `imap/${normalizeAccountName(name)}/password`;
}

let paneRegistered = false;

function registerPane() {
  const registry = globalThis.__piclawSettingsPaneRegistry || {};
  const registerSettingsPane = registry.registerSettingsPane;
  if (!registerSettingsPane || !HAS_RUNTIME || paneRegistered) return;

  registerSettingsPane({
    id: 'imap',
    label: 'IMAP',
    icon: ICON,
    order: 36,
    searchable: true,
    component: ImapPane,
  });
  paneRegistered = true;
  try { registry.notifySettingsPanesChanged?.(); } catch {}
}

function emptyDraft(name = '') {
  return {
    name,
    host: '',
    port: 143,
    user: '',
    password: '',
    from: '',
    tls: false,
    starttls: true,
    allowInsecureTls: false,
    setDefault: false,
  };
}

function ImapPane() {
  if (!HAS_RUNTIME) return null;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [defaultAccount, setDefaultAccount] = useState('');
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState(emptyDraft());

  async function refresh(preferredName) {
    setLoading(true);
    setError('');
    try {
      const payload = await api('/accounts');
      const list = payload.accounts || [];
      setAccounts(list);
      setDefaultAccount(payload.defaultAccount || '');
      const hasPreferred = typeof preferredName === 'string';
      const nextSelected = hasPreferred ? preferredName : (selected || payload.defaultAccount || list[0]?.name || '');
      setSelected(nextSelected);
      if (nextSelected) {
        const account = list.find((item) => item.name === nextSelected);
        setDraft({ ...emptyDraft(nextSelected), ...(account || {}), password: '', setDefault: nextSelected === payload.defaultAccount });
      } else {
        setDraft(emptyDraft());
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const selectedMeta = useMemo(() => accounts.find((item) => item.name === selected) || null, [accounts, selected]);

  function patch(field, value) {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  function selectAccount(account) {
    setMessage('');
    setSelected(account.name);
    setDraft({ ...emptyDraft(account.name), ...account, password: '', setDefault: account.name === defaultAccount });
  }

  async function saveCurrent() {
    const normalizedName = normalizeAccountName(draft.name);
    const existingMeta = accounts.find((item) => item.name === normalizedName) || null;
    if (!normalizedName) {
      setError('Account name is required.');
      return;
    }
    if (!String(draft.host || '').trim()) {
      setError('Host is required.');
      return;
    }
    if (!String(draft.user || '').trim()) {
      setError('Username is required.');
      return;
    }
    if (!existingMeta?.hasPassword && !String(draft.password || '').length) {
      setError('Password is required for new accounts.');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const body = {
        host: draft.host,
        port: Number(draft.port || 0),
        user: draft.user,
        from: draft.from,
        tls: !!draft.tls,
        starttls: !!draft.starttls,
        allowInsecureTls: !!draft.allowInsecureTls,
        setDefault: !!draft.setDefault,
      };
      const passwordKey = passwordKeychainName(normalizedName);
      const wroteNewPassword = Boolean(draft.password);
      const shouldRollbackPassword = wroteNewPassword && !existingMeta?.hasPassword;
      if (wroteNewPassword) {
        await setKeychainSecret(passwordKey, draft.password);
      }
      let payload;
      try {
        payload = await api('/accounts', { method: 'POST', body: JSON.stringify({ action: 'save', name: normalizedName, account: body }) });
      } catch (e) {
        if (shouldRollbackPassword) {
          try { await deleteKeychainSecret(passwordKey); } catch {}
        }
        throw e;
      }
      await refresh(payload.account?.name || normalizedName);
      setDraft((prev) => ({ ...prev, password: '' }));
      setMessage(`Saved IMAP account ${payload.account?.name || normalizedName}.`);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  async function removeCurrent() {
    if (!selected) return;
    if (!confirm(`Delete IMAP account ${selected}?`)) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api('/accounts', { method: 'POST', body: JSON.stringify({ action: 'delete', name: selected }) });
      setSelected('');
      setDraft(emptyDraft());
      await refresh('');
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  async function setDefault(name) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api('/accounts', { method: 'POST', body: JSON.stringify({ action: 'set_default', name }) });
      await refresh(name || '');
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return html`<div class="settings-loading">Loading IMAP accounts…</div>`;

  return html`
    <div class="imap-settings" style="display:flex;flex-direction:column;gap:16px;">
      <div class="settings-section">
        <h3>Accounts</h3>
        <div class="settings-hint" style="margin:0 0 12px;">
          Passwords live in keychain. Connection settings and defaults live in the SQLite KV store.
        </div>
        <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
          <button onClick=${() => { setMessage(''); setSelected(''); setDraft(emptyDraft()); }}>New account</button>
        </div>
        ${accounts.length === 0 ? html`<div class="settings-hint">No IMAP accounts yet.</div>` : html`
          <table class="settings-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Server</th>
                <th>Security</th>
                <th style="width:90px;">Default</th>
              </tr>
            </thead>
            <tbody>
              ${accounts.map((account) => html`
                <tr>
                  <td>
                    <button onClick=${() => selectAccount(account)} style=${`text-align:left;background:none;border:none;padding:0;color:inherit;font:inherit;cursor:pointer;${selected===account.name ? 'font-weight:600;' : ''}`}>
                      ${account.name}
                    </button>
                    ${account.source === 'legacy-keychain' ? html`<div class="settings-hint" style="margin-top:4px;">Legacy config</div>` : null}
                  </td>
                  <td>${account.user}@${account.host}:${account.port}</td>
                  <td>
                    ${account.tls ? 'TLS' : account.starttls ? 'STARTTLS' : 'Plain'}
                    ${account.allowInsecureTls ? html`<div class="settings-hint" style="margin-top:4px;">Accepts untrusted certs</div>` : null}
                  </td>
                  <td>${account.name === defaultAccount ? '★' : ''}</td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
      </div>

      <div class="settings-section">
        <h3>${selected ? `Edit account: ${selected}` : 'New account'}</h3>
        ${error ? html`<div style="color:var(--danger-color,#ff8080);margin-bottom:12px;">${error}</div>` : null}
        ${message ? html`<div style="color:var(--success-color,#4ade80);margin-bottom:12px;">${message}</div>` : null}

        <div class="settings-row">
          <label>Name</label>
          <input value=${draft.name} onInput=${(e) => patch('name', e.currentTarget.value)} placeholder="personal" />
        </div>
        <div class="settings-row">
          <label>Host</label>
          <input value=${draft.host} onInput=${(e) => patch('host', e.currentTarget.value)} placeholder="imap.example.com" />
        </div>
        <div class="settings-row">
          <label>Port</label>
          <input type="number" value=${draft.port} onInput=${(e) => patch('port', Number(e.currentTarget.value))} style="width:100px;" />
        </div>
        <div class="settings-row">
          <label>Username</label>
          <input value=${draft.user} onInput=${(e) => patch('user', e.currentTarget.value)} placeholder="user@example.com" />
        </div>
        <div class="settings-row">
          <label>Password</label>
          <div style="display:flex;align-items:center;gap:8px;flex:1;">
            <input type="password" value=${draft.password} onInput=${(e) => patch('password', e.currentTarget.value)} placeholder=${selectedMeta?.hasPassword ? 'Leave blank to keep existing password' : 'Required for new accounts'} />
            ${selectedMeta?.hasPassword
              ? html`<span style="font-size:0.72rem;color:var(--accent-color,#2563eb);font-weight:600;white-space:nowrap;" title=${`Stored as ${passwordKeychainName(selectedMeta.name)}`}>✓ keychain</span>`
              : html`<span style="font-size:0.72rem;color:var(--danger-color,#dc2626);font-weight:600;white-space:nowrap;" title="No password in keychain">✗ missing</span>`}
          </div>
        </div>
        <div class="settings-row">
          <label>From</label>
          <input value=${draft.from} onInput=${(e) => patch('from', e.currentTarget.value)} placeholder="Me <me@example.com>" />
        </div>
        <div class="settings-row">
          <label>Implicit TLS</label>
          <input type="checkbox" checked=${!!draft.tls} onChange=${(e) => patch('tls', e.currentTarget.checked)} />
        </div>
        <div class="settings-row">
          <label>STARTTLS</label>
          <div style="display:flex;align-items:center;gap:10px;">
            <input type="checkbox" checked=${!!draft.starttls} onChange=${(e) => patch('starttls', e.currentTarget.checked)} disabled=${!!draft.tls} />
            <span class="settings-hint" style="margin:0;">Disabled when implicit TLS is enabled.</span>
          </div>
        </div>
        <div class="settings-row">
          <label>Accept untrusted TLS certs</label>
          <input type="checkbox" checked=${!!draft.allowInsecureTls} onChange=${(e) => patch('allowInsecureTls', e.currentTarget.checked)} />
        </div>
        <div class="settings-row">
          <label>Make default</label>
          <input type="checkbox" checked=${!!draft.setDefault} onChange=${(e) => patch('setDefault', e.currentTarget.checked)} />
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
          <button onClick=${saveCurrent} disabled=${saving}>${saving ? 'Saving…' : 'Save account'}</button>
          ${selected ? html`<button onClick=${removeCurrent} disabled=${saving}>Delete</button>` : null}
          ${selected && selected !== defaultAccount ? html`<button onClick=${() => setDefault(selected)} disabled=${saving}>Set default</button>` : null}
          ${defaultAccount ? html`<button onClick=${() => setDefault('')} disabled=${saving}>Clear default</button>` : null}
        </div>
        <div class="settings-hint" style="margin-top:12px;">
          Use port 993 with implicit TLS, or port 143 with STARTTLS.
        </div>
      </div>
    </div>
  `;
}

if (typeof globalThis !== 'undefined') {
  try { registerPane(); } catch {}
  if (typeof window !== 'undefined') {
    window.addEventListener('piclaw:addons-loaded', () => { try { registerPane(); } catch {} });
  }
}
