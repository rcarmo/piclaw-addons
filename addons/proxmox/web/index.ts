// @ts-nocheck
const ADDON_ID = "proxmox";
const API = `/agent/addons/api/${ADDON_ID}`;
const DEFAULT_KEYCHAIN = "proxmox/piclaw-management-token";

const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
const html = preactHtm?.html;
const useState = preactHtm?.useState;
const useEffect = preactHtm?.useEffect;
const useCallback = preactHtm?.useCallback;
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

const ICON = HAS_RUNTIME
  ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="6" rx="1.5"></rect><rect x="4" y="14" width="16" height="6" rx="1.5"></rect><path d="M8 7h.01M8 17h.01"></path><path d="M11 7h5M11 17h5"></path></svg>`
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

function ProxmoxSettings() {
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
        setMsg("Failed to load Proxmox settings.");
      }
    } catch {
      setMsg("Failed to load Proxmox settings.");
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

  if (!cfg) return html`<div style="padding:1rem;color:var(--text-secondary)">Loading…</div>`;

  const S = { display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.4rem 0" };
  const L = { minWidth: "180px", color: "var(--text-secondary)", fontSize: "0.85rem" };
  const I = { flex: 1, padding: "4px 8px", background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", fontSize: "0.85rem" };
  const IM = { ...I, fontFamily: "var(--font-mono, monospace)", fontSize: "0.82rem" };
  const H = { margin: "1.2rem 0 0.4rem", fontSize: "0.9rem", color: "var(--text-primary)", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.3rem" };
  const hint = (t) => html`<div style=${{ fontSize: "0.73rem", color: "var(--text-secondary)", margin: "-0.15rem 0 0.4rem 188px" }}>${t}</div>`;

  const checkbox = (label, key) => html`
    <label style=${S}><span style=${L}>${label}</span>
      <input type="checkbox" checked=${cfg[key]} onChange=${(e) => save({ [key]: e.target.checked })} disabled=${saving} />
    </label>`;

  const textField = (label, key, placeholder, extra = {}) => html`
    <label style=${S}><span style=${L}>${label}</span>
      <input type="text" value=${cfg[key] ?? ""} style=${{ ...I, ...extra }} placeholder=${placeholder || ""}
        onBlur=${(e) => { if (e.target.value !== (cfg[key] ?? "")) save({ [key]: e.target.value }); }}
        onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }}
        disabled=${saving} />
    </label>`;

  return html`
    <div style="padding:0.5rem 0;">
      <h4 style=${H}>Connection</h4>
      ${textField("Host / IP", "host", "borg.local or 192.168.1.10")}
      ${hint("You can enter a hostname, IP, or full URL. The addon normalizes it to https://host:8006/api2/json.")}
      ${textField("Username", "username", "root@pam!piclaw", { fontFamily: "var(--font-mono, monospace)" })}
      ${hint("Proxmox token ID / username stored in addon KV, not in keychain.")}
      ${checkbox("Allow insecure TLS", "allow_insecure_tls")}
      ${hint("Keep this enabled for self-signed lab certificates.")}

      <h4 style=${H}>Token secret</h4>
      ${textField("Keychain entry", "api_token_keychain", DEFAULT_KEYCHAIN, { fontFamily: "var(--font-mono, monospace)" })}
      <div style=${S}>
        <span style=${L}>API token</span>
        <input type="password" value=${keyInput} style=${IM}
          placeholder=${hasKey ? "••••••• (stored in keychain)" : "paste Proxmox token secret"}
          onInput=${(e) => setKeyInput(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") saveToken(); }}
          disabled=${saving} />
        <button style="padding:4px 10px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:0.82rem"
          onClick=${saveToken} disabled=${!keyInput.trim() || saving}>Save</button>
        ${hasKey
          ? html`<span style="font-size:0.72rem;color:var(--accent-color,#2563eb);font-weight:600" title="Key in keychain">✓</span>`
          : html`<span style="font-size:0.72rem;color:var(--danger-color,#dc2626);font-weight:600" title="No key">✗</span>`}
      </div>
      ${hint(`Saved to keychain as ${currentKeychain}.`) }

      ${cfg.base_url && html`<div style=${{ marginTop: "0.9rem", fontSize: "0.78rem", color: "var(--text-secondary)" }}>
        Normalized API URL: <code style="font-family:var(--font-mono, monospace)">${cfg.base_url}</code>
      </div>`}

      ${msg && html`<div style=${{ marginTop: "0.75rem", fontSize: "0.8rem", color: msg.includes("failed") || msg.includes("Failed") ? "var(--danger-color)" : "var(--accent-color)" }}>${msg}</div>`}
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
      reg({ id: "proxmox", label: "Proxmox", icon: ICON, component: ProxmoxSettings, order: 176 });
      notify?.();
    }
  }
} catch {}
