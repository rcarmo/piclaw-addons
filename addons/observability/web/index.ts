import { settingsFieldStyles } from "./settings-fields.ts";
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
      const data = await r.json().catch(() => null);
      if (!r.ok || !data || data.error) {
        setMsg(typeof data?.error === "string" ? data.error : "Failed to load configuration (HTTP " + r.status + "). Reload the settings pane to try again."); return;
      }
      setCfg(data);
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
        setMsg(j.warning || "Saved");

      } else {
        setMsg(j.error || "Save failed");
      }
      return j;
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
      const result = await save({ appinsights_keychain: KEYCHAIN_ENTRY });
      if (result?.ok && !result.warning) setMsg("Connection string saved to keychain and configuration applied.");
    } else {
      setMsg("Failed to save connection string.");
    }
  }, [keyInput, save]);

  if (!cfg) return msg
    ? html`<p class="settings-addon-error" role="alert">${msg}</p>`
    : html`<p class="settings-addon-status" role="status">Loading…</p>`;

  const hint = (t) => html`<p class="settings-addon-help">${t}</p>`;

  const check = (label, key) => html`
    <label class="settings-addon-check">
      <input type="checkbox" checked=${cfg[key]} onChange=${(e) => save({ [key]: e.target.checked })} disabled=${saving} />
      ${label}
    </label>`;

  const text = (label, key, placeholder) => html`
    <label class="settings-addon-field"><span class="settings-addon-label">${label}</span>
      <input class="settings-addon-control" type="text" value=${cfg[key] ?? ""} placeholder=${placeholder || ""}
        onBlur=${(e) => { if (e.target.value !== (cfg[key] ?? "")) save({ [key]: e.target.value }); }}
        onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }} disabled=${saving} />
    </label>`;

  const num = (label, key, placeholder) => html`
    <label class="settings-addon-field"><span class="settings-addon-label">${label}</span>
      <input class="settings-addon-control" type="text" inputmode="numeric" value=${cfg[key] ?? ""} placeholder=${placeholder || ""}
        onBlur=${(e) => { const v = Number(e.target.value); if (!isNaN(v) && v !== cfg[key]) save({ [key]: v }); }}
        onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }} disabled=${saving} />
    </label>`;

  return html`
    <div data-settings-addon="observability" class="settings-addon-section">
      <style>${settingsFieldStyles}</style>
      <h4 class="settings-addon-heading">General</h4>
      ${check("Enabled", "enabled")}
      ${text("Instance name", "instance_name", hostname())}
      ${hint("Identifies this piclaw instance in App Insights (cloud_RoleInstance). Blank = hostname.")}

      <h4 class="settings-addon-heading">Azure Application Insights</h4>
      ${check("App Insights enabled", "appinsights_enabled")}
      <div class="settings-addon-field">
        <label class="settings-addon-label" for="observability-secret">Connection string</label>
        <div class="settings-addon-control-group">
        <input id="observability-secret" class="settings-addon-control settings-addon-mono" type="password" value=${keyInput}
          placeholder=${hasKey ? "••••••• (stored in keychain)" : "InstrumentationKey=...;IngestionEndpoint=..."}
          onInput=${(e) => setKeyInput(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") saveConnectionString(); }}
          disabled=${saving} />
        <button type="button" onClick=${saveConnectionString} disabled=${!keyInput.trim() || saving}>Save</button>
        ${hasKey
          ? html`<span class="settings-addon-badge" data-tone="success">Stored</span>`
          : html`<span class="settings-addon-badge" data-tone="danger">Not set</span>`
        }
        </div>
      </div>
      ${hint("Saved to keychain as " + KEYCHAIN_ENTRY + ". The status message reports whether the backend activated.")}
      ${check("Live Metrics Stream", "appinsights_live_metrics")}
      ${hint("Real-time telemetry in the Azure portal (QuickPulse).")}
      ${check("Standard metrics", "appinsights_standard_metrics")}
      ${num("Sampling ratio", "appinsights_sampling_ratio", "1")}
      ${hint("0–1. 1 = send all traces. 0.5 = sample 50%.")}

      <h4 class="settings-addon-heading">Graphite (Carbon plaintext)</h4>
      ${check("Graphite enabled", "graphite_enabled")}
      ${text("Host", "graphite_host", "192.168.1.250")}
      ${num("Port", "graphite_port", "2003")}
      <p class="settings-addon-help">Metrics use the fixed <code>piclaw</code> prefix.</p>

      <h4 class="settings-addon-heading">Usage and compaction telemetry</h4>
      ${check("Export usage and compaction telemetry", "usage_telemetry_enabled")}
      ${hint("Exports local token usage plus bounded compaction timing/outcome metrics by instance and model. Failed exports are retained in bounded local spools.")}
      ${num("Export interval (minutes)", "usage_telemetry_interval_minutes", "15")}
      ${text("Graphite render URL", "graphite_render_url", "http://192.168.1.250:8086")}
      ${hint("Optional; used by the bundled usage-telemetry-chart skill to render SVG charts.")}

      ${msg && (/failed/i.test(msg)
        ? html`<p class="settings-addon-error" role="alert">${msg}</p>`
        : html`<p class="settings-addon-status" role="status">${msg}</p>`)}
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
