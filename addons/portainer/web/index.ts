// @ts-nocheck
import { settingsFieldStyles } from "./settings-fields.ts";
const ADDON_ID = "portainer";
const API = `/agent/addons/api/${ADDON_ID}`;
const DEFAULT_KEYCHAIN = "portainer/relay";

const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
const html = preactHtm?.html;
const useState = preactHtm?.useState;
const useEffect = preactHtm?.useEffect;
const useCallback = preactHtm?.useCallback;
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

const ICON = HAS_RUNTIME
  ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="7" height="5.5" rx="1"></rect><rect x="13.5" y="7" width="7" height="5.5" rx="1"></rect><rect x="8.5" y="13.5" width="7" height="5.5" rx="1"></rect><path d="M12 13.5v-1.5"></path></svg>`
  : null;

async function loadKeychainHas(name) {
  try {
    const r = await fetch("/agent/keychain");
    if (!r.ok) return false;
    const data = await r.json();
    return (data.entries || []).some((entry) => entry.name === name);
  } catch {
    return false;
  }
}

async function setKeychainSecret(name, secret) {
  try {
    const r = await fetch("/agent/keychain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, secret, type: "secret" }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function PortainerSettings() {
  if (!HAS_RUNTIME) return null;
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");

  const currentKeychain = (cfg?.api_token_keychain || DEFAULT_KEYCHAIN).trim() || DEFAULT_KEYCHAIN;

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/config`);
      if (r.ok) {
        const data = await r.json();
        setCfg(data);
        setHasKey(await loadKeychainHas((data?.api_token_keychain || DEFAULT_KEYCHAIN).trim() || DEFAULT_KEYCHAIN));
      } else {
        setMsg("Failed to load Portainer settings.");
      }
    } catch {
      setMsg("Failed to load Portainer settings.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (patch) => {
    setSaving(true);
    setMsg("");
    try {
      const r = await fetch(`${API}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (j.ok) {
        setCfg(j.config);
        setMsg("Saved.");
        setHasKey(await loadKeychainHas((j.config?.api_token_keychain || DEFAULT_KEYCHAIN).trim() || DEFAULT_KEYCHAIN));
        setTimeout(() => setMsg(""), 2500);
      } else {
        setMsg(j.error || "Save failed.");
      }
    } catch {
      setMsg("Save failed.");
    } finally {
      setSaving(false);
    }
  }, []);

  const saveToken = useCallback(async () => {
    const secret = keyInput.trim();
    if (!secret) return;
    setSaving(true);
    const keychainName = currentKeychain;
    const ok = await setKeychainSecret(keychainName, secret);
    setSaving(false);
    if (ok) {
      setHasKey(true);
      setKeyInput("");
      await save({ api_token_keychain: keychainName });
      setMsg(`Token saved to keychain as ${keychainName}.`);
      setTimeout(() => setMsg(""), 5000);
    } else {
      setMsg("Failed to save token.");
    }
  }, [currentKeychain, keyInput, save]);

  if (!cfg) return html`<p class="settings-addon-status" role="status">Loading…</p>`;

  const hint = (t) => html`<p class="settings-addon-help">${t}</p>`;

  const checkbox = (label, key) => html`
    <label class="settings-addon-check">
      <input type="checkbox" checked=${cfg[key]} onChange=${(e) => save({ [key]: e.target.checked })} disabled=${saving} />
      ${label}
    </label>`;

  const textField = (label, key, placeholder, mono = false) => html`
    <label class="settings-addon-field"><span class="settings-addon-label">${label}</span>
      <input class=${`settings-addon-control${mono ? " settings-addon-mono" : ""}`} type="text" value=${cfg[key] ?? ""} placeholder=${placeholder || ""}
        onBlur=${(e) => { if (e.target.value !== (cfg[key] ?? "")) save({ [key]: e.target.value }); }}
        onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }}
        disabled=${saving} />
    </label>`;

  return html`
    <div data-settings-addon="portainer" class="settings-addon-section">
      <style>${settingsFieldStyles}</style>
      <h4 class="settings-addon-heading">Connection</h4>
      ${textField("Host / IP", "host", "relay.local or 192.168.1.20")}
      ${hint("You can enter a hostname, IP, or full URL. The addon normalizes bare hosts to https://host:9443.")}
      ${checkbox("Allow insecure TLS", "allow_insecure_tls")}
      ${hint("Keep this enabled for self-signed lab certificates.")}

      <h4 class="settings-addon-heading">Token secret</h4>
      ${textField("Keychain entry", "api_token_keychain", DEFAULT_KEYCHAIN, true)}
      <div class="settings-addon-field">
        <label class="settings-addon-label" for="portainer-secret">API token</label>
        <div class="settings-addon-control-group">
        <input id="portainer-secret" class="settings-addon-control settings-addon-mono" type="password" value=${keyInput}
          placeholder=${hasKey ? "••••••• (stored in keychain)" : "paste Portainer API token"}
          onInput=${(e) => setKeyInput(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") saveToken(); }}
          disabled=${saving} />
        <button type="button" onClick=${saveToken} disabled=${!keyInput.trim() || saving}>Save</button>
        ${hasKey
          ? html`<span class="settings-addon-badge" data-tone="success">Stored</span>`
          : html`<span class="settings-addon-badge" data-tone="danger">Not set</span>`}
        </div>
      </div>
      ${hint(`Saved to keychain as ${currentKeychain}.`) }

      ${cfg.base_url && html`<p class="settings-addon-help">
        Normalized base URL: <code class="settings-addon-mono">${cfg.base_url}</code>
      </p>`}

      ${msg && (/failed/i.test(msg)
        ? html`<p class="settings-addon-error" role="alert">${msg}</p>`
        : html`<p class="settings-addon-status" role="status">${msg}</p>`)}
    </div>`;
}

try {
  if (HAS_RUNTIME) {
    let reg, notify;
    const r = globalThis.__piclawSettingsPaneRegistry;
    if (r) { reg = r.registerSettingsPane; notify = r.notifySettingsPanesChanged; }
    if (!reg && globalThis.__piclaw_web?.registerSettingsPane) {
      reg = globalThis.__piclaw_web.registerSettingsPane;
      notify = () => globalThis.dispatchEvent?.(new CustomEvent("piclaw:settings-panes-changed"));
    }
    if (reg) {
      reg({ id: "portainer", label: "Portainer", icon: ICON, component: PortainerSettings, order: 177 });
      notify?.();
    }
  }
} catch {}
