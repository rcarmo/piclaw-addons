/**
 * observability/web/index.ts — Settings pane only.
 *
 * Config in extension KV. Connection string saved directly to keychain.
 * Browser-side telemetry is intentionally not installed; App Insights user/session
 * UX fields are synthesized from backend log-sink telemetry instead.
 */
// @ts-nocheck
const ADDON_ID = "observability";
const API = `/agent/addons/api/${ADDON_ID}`;
const KEYCHAIN_ENTRY = "azure/appinsights-connection-string";

const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
const html = preactHtm?.html;
const useState = preactHtm?.useState;
const useEffect = preactHtm?.useEffect;
const useCallback = preactHtm?.useCallback;
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

const ICON = HAS_RUNTIME
  ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`
  : null;

async function loadKeychainHas(name) {
  try {
    const r = await fetch("/agent/keychain");
    if (!r.ok) return false;
    const data = await r.json();
    return (data.entries || []).some((e) => e.name === name);
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

function ObservabilitySettings() {
  if (!HAS_RUNTIME) return null;
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/config`);
      if (r.ok) setCfg(await r.json());
    } catch {
      setMsg("Failed to load config");
    }
    setHasKey(await loadKeychainHas(KEYCHAIN_ENTRY));
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
        setMsg("Saved");
        setTimeout(() => setMsg(""), 2000);
      } else {
        setMsg(j.error || "Save failed");
      }
    } catch {
      setMsg("Save failed");
    } finally {
      setSaving(false);
    }
  }, []);

  const saveConnectionString = useCallback(async () => {
    const secret = keyInput.trim();
    if (!secret) return;
    setSaving(true);
    const ok = await setKeychainSecret(KEYCHAIN_ENTRY, secret);
    setSaving(false);
    if (ok) {
      setHasKey(true);
      setKeyInput("");
      await save({ appinsights_keychain: KEYCHAIN_ENTRY });
      setMsg("Connection string saved to keychain. Restart required.");
      setTimeout(() => setMsg(""), 5000);
    } else {
      setMsg("Failed to save connection string.");
    }
  }, [keyInput, save]);

  if (!cfg) return html`<div style="padding:1rem;color:var(--text-secondary)">Loading…</div>`;

  const S = { display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.4rem 0" };
  const L = { minWidth: "180px", color: "var(--text-secondary)", fontSize: "0.85rem" };
  const I = { flex: 1, padding: "4px 8px", background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", fontSize: "0.85rem" };
  const IM = { ...I, fontFamily: "var(--font-mono, monospace)", fontSize: "0.82rem" };
  const H = { margin: "1.2rem 0 0.4rem", fontSize: "0.9rem", color: "var(--text-primary)", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.3rem" };
  const hint = (t) => html`<div style=${{ fontSize: "0.73rem", color: "var(--text-secondary)", margin: "-0.15rem 0 0.4rem 188px" }}>${t}</div>`;

  const check = (label, key) => html`
    <label style=${S}><span style=${L}>${label}</span>
      <input type="checkbox" checked=${cfg[key]} onChange=${(e) => save({ [key]: e.target.checked })} disabled=${saving} />
    </label>`;

  const text = (label, key, placeholder) => html`
    <label style=${S}><span style=${L}>${label}</span>
      <input type="text" value=${cfg[key] ?? ""} style=${I} placeholder=${placeholder || ""}
        onBlur=${(e) => { if (e.target.value !== (cfg[key] ?? "")) save({ [key]: e.target.value }); }}
        onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }} disabled=${saving} />
    </label>`;

  const num = (label, key, placeholder) => html`
    <label style=${S}><span style=${L}>${label}</span>
      <input type="text" inputmode="numeric" value=${cfg[key] ?? ""} style=${{ ...I, maxWidth: "100px" }} placeholder=${placeholder || ""}
        onBlur=${(e) => { const v = Number(e.target.value); if (!isNaN(v) && v !== cfg[key]) save({ [key]: v }); }}
        onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }} disabled=${saving} />
    </label>`;

  return html`
    <div style="padding:0.5rem 0;">
      <h4 style=${H}>General</h4>
      ${check("Enabled", "enabled")}
      ${text("Instance name", "instance_name", hostname())}
      ${hint("Identifies this piclaw instance in App Insights (cloud_RoleInstance). Blank = hostname.")}

      <h4 style=${H}>Azure Application Insights</h4>
      ${check("App Insights enabled", "appinsights_enabled")}
      <div style=${S}>
        <span style=${L}>Connection string</span>
        <input type="password" value=${keyInput} style=${IM}
          placeholder=${hasKey ? "••••••• (stored in keychain)" : "InstrumentationKey=...;IngestionEndpoint=..."}
          onInput=${(e) => setKeyInput(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") saveConnectionString(); }}
          disabled=${saving} />
        <button style="padding:4px 10px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:0.82rem"
          onClick=${saveConnectionString} disabled=${!keyInput.trim() || saving}>Save</button>
        ${hasKey
          ? html`<span style="font-size:0.72rem;color:var(--accent-color,#2563eb);font-weight:600" title="Key in keychain">✓</span>`
          : html`<span style="font-size:0.72rem;color:var(--danger-color,#dc2626);font-weight:600" title="No key">✗</span>`
        }
      </div>
      ${hint("Saved to keychain as " + KEYCHAIN_ENTRY + ". Restart required after changing.")}
      ${check("Live Metrics Stream", "appinsights_live_metrics")}
      ${hint("Real-time telemetry in the Azure portal (QuickPulse).")}
      ${check("Standard metrics", "appinsights_standard_metrics")}
      ${num("Sampling ratio", "appinsights_sampling_ratio", "1")}
      ${hint("0–1. 1 = send all traces. 0.5 = sample 50%.")}

      <h4 style=${H}>Graphite (Carbon plaintext)</h4>
      ${check("Graphite enabled", "graphite_enabled")}
      ${text("Host", "graphite_host", "192.168.1.250")}
      ${num("Port", "graphite_port", "2003")}
      ${text("Metric prefix", "graphite_prefix", "piclaw")}

      ${msg && html`<div style=${{ marginTop: "0.75rem", fontSize: "0.8rem", color: msg.includes("failed") || msg.includes("Failed") ? "var(--danger-color)" : "var(--accent-color)" }}>${msg}</div>`}
    </div>`;
}

function hostname() {
  try { return location?.hostname || ""; } catch { return ""; }
}

let observabilityPaneRegistered = false;

function registerObservabilitySettingsPane() {
  if (!HAS_RUNTIME || observabilityPaneRegistered) return observabilityPaneRegistered;
  let reg, notify;
  const r = globalThis.__piclawSettingsPaneRegistry;
  if (r) { reg = r.registerSettingsPane; notify = r.notifySettingsPanesChanged; }
  if (!reg && globalThis.__piclaw_web?.registerSettingsPane) {
    reg = globalThis.__piclaw_web.registerSettingsPane;
    notify = () => globalThis.dispatchEvent?.(new CustomEvent("piclaw:settings-panes-changed"));
  }
  if (!reg) return false;
  reg({ id: "observability", label: "Observability", icon: ICON, component: ObservabilitySettings, order: 170 });
  notify?.();
  observabilityPaneRegistered = true;
  return true;
}

function scheduleObservabilitySettingsPaneRegistration() {
  if (!HAS_RUNTIME || observabilityPaneRegistered) return;
  const attempt = () => {
    try {
      registerObservabilitySettingsPane();
    } catch {}
  };
  attempt();
  try { queueMicrotask(attempt); } catch {}
  try { setTimeout(attempt, 0); } catch {}
  try { setTimeout(attempt, 250); } catch {}
  try { setTimeout(attempt, 1000); } catch {}
  try { globalThis.requestAnimationFrame?.(() => attempt()); } catch {}
  try { globalThis.addEventListener?.("load", attempt, { once: true }); } catch {}
}

try {
  scheduleObservabilitySettingsPaneRegistration();
} catch {}
