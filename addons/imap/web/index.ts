/**
 * IMAP settings pane — SQLite KV + keychain account manager.
 */
// @ts-nocheck
const API_BASE = '/imap-settings/api';

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

function registerPane() {
  const registry = globalThis.__piclawSettingsPaneRegistry || {};
  const registerSettingsPane = registry.registerSettingsPane;
  if (!registerSettingsPane) return;

  registerSettingsPane({
    id: 'imap',
    label: 'IMAP',
    order: 36,
    searchable: true,
    component: ImapPane,
  });
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
  const { html, useEffect, useMemo, useState } = globalThis.__piclawPreact || {};
  if (!html) return null;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
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
      const nextSelected = preferredName || selected || payload.defaultAccount || list[0]?.name || '';
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

  async function saveCurrent() {
    if (!draft.name) {
      setError('Account name is required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body = {
        host: draft.host,
        port: Number(draft.port || 0),
        user: draft.user,
        from: draft.from,
        tls: !!draft.tls,
        starttls: !!draft.starttls,
        allowInsecureTls: !!draft.allowInsecureTls,
        password: draft.password || undefined,
        setDefault: !!draft.setDefault,
      };
      const payload = await api(`/accounts/${encodeURIComponent(draft.name)}`, { method: 'PUT', body: JSON.stringify(body) });
      await refresh(payload.account?.name || draft.name);
      setDraft((prev) => ({ ...prev, password: '' }));
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
    try {
      await api(`/accounts/${encodeURIComponent(selected)}`, { method: 'DELETE' });
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
    try {
      await api('/default', { method: 'POST', body: JSON.stringify({ name }) });
      await refresh(name || '');
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return html`<div class="settings-loading">Loading IMAP accounts…</div>`;

  return html`
    <div class="imap-settings" style="display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:start;">
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong>Accounts</strong>
          <button onClick=${() => { setSelected(''); setDraft(emptyDraft()); }}>New</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${accounts.map((account) => html`
            <button
              style=${`text-align:left;padding:10px;border-radius:8px;border:1px solid var(--border-color,#333);background:${selected===account.name ? 'var(--accent-bg,#1f2f4a)' : 'var(--panel-bg,#111)'};color:inherit;`}
              onClick=${() => {
                setSelected(account.name);
                setDraft({ ...emptyDraft(account.name), ...account, password: '', setDefault: account.name === defaultAccount });
              }}>
              <div style="font-weight:600;display:flex;justify-content:space-between;gap:8px;">
                <span>${account.name}</span>
                ${account.name === defaultAccount ? html`<span title="Default">★</span>` : null}
              </div>
              <div style="font-size:12px;opacity:.75">${account.user}@${account.host}:${account.port}</div>
              <div style="font-size:11px;opacity:.65">
                ${account.tls ? 'TLS' : account.starttls ? 'STARTTLS' : 'Plain'}
                ${account.allowInsecureTls ? ' • insecure certs accepted' : ''}
                ${account.source === 'legacy-keychain' ? ' • legacy' : ''}
              </div>
            </button>
          `)}
          ${accounts.length === 0 ? html`<div style="opacity:.7;font-size:12px">No IMAP accounts yet.</div>` : null}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${error ? html`<div style="color:#ff8080">${error}</div>` : null}
        <label>Name <input value=${draft.name} onInput=${(e) => patch('name', e.currentTarget.value)} placeholder="personal" /></label>
        <div style="display:grid;grid-template-columns:1fr 100px;gap:12px;">
          <label>Host <input value=${draft.host} onInput=${(e) => patch('host', e.currentTarget.value)} placeholder="imap.example.com" /></label>
          <label>Port <input type="number" value=${draft.port} onInput=${(e) => patch('port', Number(e.currentTarget.value))} /></label>
        </div>
        <label>Username <input value=${draft.user} onInput=${(e) => patch('user', e.currentTarget.value)} placeholder="user@example.com" /></label>
        <label>Password <input type="password" value=${draft.password} onInput=${(e) => patch('password', e.currentTarget.value)} placeholder=${selectedMeta?.hasPassword ? 'Leave blank to keep existing password' : 'Required for new accounts'} /></label>
        <label>From <input value=${draft.from} onInput=${(e) => patch('from', e.currentTarget.value)} placeholder="Rui Carmo <rui@example.com>" /></label>
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;">
          <label><input type="checkbox" checked=${!!draft.tls} onChange=${(e) => patch('tls', e.currentTarget.checked)} /> Use implicit TLS</label>
          <label><input type="checkbox" checked=${!!draft.starttls} onChange=${(e) => patch('starttls', e.currentTarget.checked)} disabled=${!!draft.tls} /> Use STARTTLS</label>
          <label><input type="checkbox" checked=${!!draft.allowInsecureTls} onChange=${(e) => patch('allowInsecureTls', e.currentTarget.checked)} /> Accept untrusted TLS certs</label>
        </div>
        <label><input type="checkbox" checked=${!!draft.setDefault} onChange=${(e) => patch('setDefault', e.currentTarget.checked)} /> Make this the default account</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button onClick=${saveCurrent} disabled=${saving}>${saving ? 'Saving…' : 'Save account'}</button>
          ${selected ? html`<button onClick=${removeCurrent} disabled=${saving}>Delete</button>` : null}
          ${selected && selected !== defaultAccount ? html`<button onClick=${() => setDefault(selected)} disabled=${saving}>Set default</button>` : null}
          ${defaultAccount ? html`<button onClick=${() => setDefault('')} disabled=${saving}>Clear default</button>` : null}
        </div>
        <div class="settings-hint" style="font-size:12px;opacity:.75;">
          Passwords are stored in keychain. Host, port, username, security mode, and certificate policy are stored in the SQLite KV store.
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
