/**
 * sample-addon/web/index.ts — Settings pane for the sample add-on.
 *
 * Demonstrates:
 *   - Checkbox, text, and password (keychain secret) fields
 *   - Reading/writing config via the addon command API
 *   - Saving secrets to keychain via POST /agent/keychain
 *   - Showing keychain key presence indicator (✓/✗)
 */
// @ts-nocheck
const ADDON_ID = "sample-addon";
const API = `/agent/addons/api/${ADDON_ID}`;
const DEFAULT_KEYCHAIN_ENTRY = "sample-addon/api-key";

const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
const html = preactHtm?.html;
const useState = preactHtm?.useState;
const useEffect = preactHtm?.useEffect;
const useCallback = preactHtm?.useCallback;
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

const ICON = HAS_RUNTIME
  ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`
  : null;

// ── Keychain helpers ─────────────────────────────────────────────

async function loadKeychainHas(name) {
  try {
    const r = await fetch("/agent/keychain");
    if (!r.ok) return false;
    const data = await r.json();
    return (data.entries || []).some(e => e.name === name);
  } catch { return false; }
}

async function setKeychainSecret(name, secret) {
  try {
    const r = await fetch("/agent/keychain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, secret, type: "token" }),
    });
    return r.ok;
  } catch { return false; }
}

// ── Config helpers ───────────────────────────────────────────────

async function loadConfig() {
  try { const r = await fetch(`${API}/config`); return r.ok ? await r.json() : {}; }
  catch { return {}; }
}

async function saveConfig(patch) {
  try {
    const r = await fetch(`${API}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return r.ok ? await r.json() : { ok: false };
  } catch { return { ok: false }; }
}

// ── Settings pane component ──────────────────────────────────────

function SampleAddonSettings() {
  if (!HAS_RUNTIME) return null;
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");

  const load = useCallback(async () => {
    const c = await loadConfig();
    setCfg(c);
    setHasKey(await loadKeychainHas(c.secret_keychain || DEFAULT_KEYCHAIN_ENTRY));
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (patch) => {
    setSaving(true); setMsg("");
    const result = await saveConfig(patch);
    if (result.ok && result.config) {
      setCfg(result.config);
      setMsg("Saved"); setTimeout(() => setMsg(""), 2000);
    } else {
      setMsg(result.error || "Save failed");
    }
    setSaving(false);
  }, []);

  const saveSecret = useCallback(async () => {
    const secret = keyInput.trim();
    if (!secret) return;
    setSaving(true);
    const name = cfg?.secret_keychain || DEFAULT_KEYCHAIN_ENTRY;
    const ok = await setKeychainSecret(name, secret);
    setSaving(false);
    if (ok) {
      setHasKey(true);
      setKeyInput("");
      setMsg("Secret saved to keychain. Restart required.");
      setTimeout(() => setMsg(""), 5000);
    } else {
      setMsg("Failed to save secret.");
    }
  }, [keyInput, cfg]);

  if (!cfg) return html`<div style="padding:1rem;color:var(--text-secondary)">Loading…</div>`;

  // ── Styles ─────────────────────────────────────────────────────
  const S = { display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.4rem 0" };
  const L = { minWidth: "140px", color: "var(--text-secondary)", fontSize: "0.85rem" };
  const I = { flex: 1, padding: "4px 8px", background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", fontSize: "0.85rem" };
  const H = { margin: "1.2rem 0 0.4rem", fontSize: "0.9rem", color: "var(--text-primary)", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.3rem" };
  const hint = (t) => html`<div style=${{ fontSize: "0.73rem", color: "var(--text-secondary)", margin: "-0.15rem 0 0.4rem 148px" }}>${t}</div>`;

  return html`
    <div style="padding:0.5rem 0;">

      <h4 style=${H}>General</h4>

      <label style=${S}>
        <span style=${L}>Enabled</span>
        <input type="checkbox" checked=${cfg.enabled}
          onChange=${(e) => save({ enabled: e.target.checked })} disabled=${saving} />
      </label>

      <label style=${S}>
        <span style=${L}>Greeting</span>
        <input type="text" value=${cfg.greeting ?? ""} style=${I}
          placeholder="Hello from sample addon!"
          onBlur=${(e) => { if (e.target.value !== (cfg.greeting ?? "")) save({ greeting: e.target.value }); }}
          onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }}
          disabled=${saving} />
      </label>
      ${hint("A non-secret value stored in the runtime database (SQLite KV).")}

      <h4 style=${H}>Secret (keychain)</h4>

      <div style=${S}>
        <span style=${L}>API key</span>
        <input type="password" value=${keyInput} style=${{ ...I, fontFamily: "var(--font-mono, monospace)" }}
          placeholder=${hasKey ? "••••••• (stored in keychain)" : "paste secret here"}
          onInput=${(e) => setKeyInput(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") saveSecret(); }}
          disabled=${saving} />
        <button style="padding:4px 10px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:0.82rem"
          onClick=${saveSecret} disabled=${!keyInput.trim() || saving}>Save</button>
        ${hasKey
          ? html`<span style="font-size:0.72rem;color:var(--accent-color,#2563eb);font-weight:600" title="Key in keychain">✓</span>`
          : html`<span style="font-size:0.72rem;color:var(--danger-color,#dc2626);font-weight:600" title="No key">✗</span>`
        }
      </div>
      ${hint("Saved to keychain as " + (cfg.secret_keychain || DEFAULT_KEYCHAIN_ENTRY) + ". Restart required after changing.")}

      <h4 style=${H}>Test</h4>
      <div style=${{ fontSize: "0.85rem", color: "var(--text-secondary)", margin: "0.4rem 0" }}>
        Use the <code>sample_test</code> tool in any chat to verify the addon is working.
        It returns the greeting and whether the secret is configured.
      </div>

      ${msg && html`<div style=${{ marginTop: "0.75rem", fontSize: "0.8rem", color: msg.includes("failed") || msg.includes("Failed") ? "var(--danger-color)" : "var(--accent-color)" }}>${msg}</div>`}
    </div>`;
}

// ── Register ─────────────────────────────────────────────────────

try {
  if (HAS_RUNTIME) {
    let reg, notify;
    const r = globalThis.__piclawSettingsPaneRegistry;
    if (r) { reg = r.registerSettingsPane; notify = r.notifySettingsPanesChanged; }
    if (!reg && globalThis.__piclaw_web?.registerSettingsPane) {
      reg = globalThis.__piclaw_web.registerSettingsPane;
      notify = () => globalThis.dispatchEvent?.(new CustomEvent('piclaw:settings-panes-changed'));
    }
    if (reg) {
      reg({ id: "sample-addon", label: "Sample Addon", icon: ICON, component: SampleAddonSettings, order: 200 });
      notify?.();
    }
  }
} catch {}
