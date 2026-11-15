/**
 * sample-addon/web/index.ts — Settings pane for the sample add-on.
 *
 * Demonstrates:
 *   - Checkbox, text, and password (keychain secret) fields
 *   - Reading/writing config via the direct backend addon config API
 *   - Saving secrets to keychain via POST /agent/keychain
 *   - Showing keychain key presence indicator (✓/✗)
 */
// @ts-nocheck
import { settingsStyles } from "./styles.ts";
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
  try {
    const r = await fetch(`${API}/config`);
    if (!r.ok) return {};
    const data = await r.json();
    return data?.config && typeof data.config === "object" ? data.config : data;
  } catch { return {}; }
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
  const [greetingDraft, setGreetingDraft] = useState("");

  const load = useCallback(async () => {
    const c = await loadConfig();
    setCfg(c);
    setGreetingDraft(c.greeting ?? "");
    setHasKey(await loadKeychainHas(c.secret_keychain || DEFAULT_KEYCHAIN_ENTRY));
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (patch) => {
    setSaving(true); setMsg("");
    const result = await saveConfig(patch);
    if (result.ok && result.config) {
      setCfg(result.config);
      setGreetingDraft(result.config.greeting ?? "");
      setMsg("Saved"); setTimeout(() => setMsg(""), 2000);
    } else {
      setMsg(result.error || "Save failed");
    }
    setSaving(false);
  }, []);

  const saveSecret = useCallback(async (rawSecret) => {
    const secret = String(rawSecret ?? keyInput).trim();
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

  if (!cfg) return html`<div class="sample-addon-settings"><style>${settingsStyles}</style><p class="settings-addon-status" role="status">Loading…</p></div>`;

  return html`
    <div class="sample-addon-settings">
      <style>${settingsStyles}</style>
      <section class="settings-addon-section">
      <h4>General</h4>

      <label class="settings-addon-control-group settings-addon-label">
        <span>Enabled</span>
        <input type="checkbox" checked=${cfg.enabled}
          onChange=${(e) => save({ enabled: e.target.checked })} disabled=${saving} />
      </label>

      <div class="settings-addon-field">
        <label class="settings-addon-label" for="sample-addon-greeting">Greeting</label>
        <input id="sample-addon-greeting" class="settings-addon-control" aria-describedby="sample-addon-greeting-help" key=${`greeting-${cfg.greeting ?? ""}`} type="text" defaultValue=${cfg.greeting ?? ""}
          placeholder="Hello from sample addon!"
          onInput=${(e) => setGreetingDraft(e.target.value)}
          onChange=${(e) => setGreetingDraft(e.target.value)}
          onBlur=${(e) => { const value = e.target.value; if (value !== (cfg.greeting ?? "")) save({ greeting: value }); }}
          onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }}
          disabled=${saving} />
        <span id="sample-addon-greeting-help" class="settings-addon-help">A non-secret value stored in the runtime database (SQLite KV).</span>
      </div>
      </section>

      <section class="settings-addon-section">
      <h4>Secret (keychain)</h4>
      <div class="settings-addon-field">
        <label class="settings-addon-label" for="sample-addon-api-key">API key</label>
        <div class="settings-addon-control-group">
        <input id="sample-addon-api-key" class="settings-addon-control settings-addon-mono" aria-describedby="sample-addon-api-key-help" key=${hasKey ? "api-key-stored" : "api-key-empty"} type="password" defaultValue=""
          placeholder=${hasKey ? "••••••• (stored in keychain)" : "paste secret here"}
          onInput=${(e) => setKeyInput(e.target.value)}
          onChange=${(e) => setKeyInput(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") saveSecret(e.target.value); }}
          disabled=${saving} />
        <button type="button"
          onClick=${(e) => saveSecret(e.currentTarget?.parentElement?.querySelector?.('input[type="password"]')?.value ?? keyInput)} disabled=${saving}>Save</button>
        ${hasKey
          ? html`<span class="settings-addon-badge" data-tone="success">Stored</span>`
          : html`<span class="settings-addon-badge" data-tone="danger">Not set</span>`
        }
        </div>
        <span id="sample-addon-api-key-help" class="settings-addon-help">Saved to keychain as ${cfg.secret_keychain || DEFAULT_KEYCHAIN_ENTRY}. Restart required after changing.</span>
      </div>
      </section>

      <section class="settings-addon-section">
      <h4>Test</h4>
      <p class="settings-addon-help">
        Use the <code>sample_test</code> tool in any chat to verify the addon is working.
        It returns the greeting and whether the secret is configured.
      </p>
      </section>

      ${msg && html`<div class=${/failed/i.test(msg) ? "settings-addon-error" : "settings-addon-status"} role=${/failed/i.test(msg) ? "alert" : "status"}>${msg}</div>`}
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
