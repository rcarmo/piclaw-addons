/**
 * observability/web/index.ts — Settings pane for OTel observability.
 *
 * All fields directly configurable. Secrets stay in keychain — only
 * the keychain entry *name* is stored here.
 */
// @ts-nocheck
const ADDON_ID = "observability";
const API = `/agent/addons/api/${ADDON_ID}`;

let html, useState, useEffect, useCallback;
try {
  const p = globalThis.__piclawPreactHtm || require("../../vendor/preact-htm.js");
  html = p.html; useState = p.useState; useEffect = p.useEffect; useCallback = p.useCallback;
} catch { return; }

const ICON = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

function ObservabilitySettings() {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try { const r = await fetch(`${API}/config`); if (r.ok) setCfg(await r.json()); }
    catch { setMsg("Failed to load config"); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (patch) => {
    setSaving(true); setMsg("");
    try {
      const r = await fetch(`${API}/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const j = await r.json();
      if (j.ok) { setCfg(j.config); setMsg("Saved"); setTimeout(() => setMsg(""), 2000); }
      else setMsg(j.error || "Save failed");
    } catch { setMsg("Save failed"); }
    finally { setSaving(false); }
  }, []);

  if (!cfg) return html`<div style="padding:1rem;color:var(--text-secondary)">Loading…</div>`;

  const S = { display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.4rem 0" };
  const L = { minWidth: "180px", color: "var(--text-secondary)", fontSize: "0.85rem" };
  const I = { flex: 1, padding: "4px 8px", background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", fontSize: "0.85rem" };
  const H = { margin: "1.2rem 0 0.4rem", fontSize: "0.9rem", color: "var(--text-primary)", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.3rem" };
  const hint = (text) => html`<div style=${{ fontSize: "0.73rem", color: "var(--text-secondary)", margin: "-0.15rem 0 0.4rem 188px" }}>${text}</div>`;

  const check = (label, key) => html`
    <label style=${S}><span style=${L}>${label}</span>
      <input type="checkbox" checked=${cfg[key]} onChange=${(e) => save({ [key]: e.target.checked })} disabled=${saving} />
    </label>`;

  const text = (label, key, placeholder) => html`
    <label style=${S}><span style=${L}>${label}</span>
      <input type="text" value=${cfg[key] ?? ""} style=${I} placeholder=${placeholder || ""}
        onBlur=${(e) => { if (e.target.value !== (cfg[key]??"")) save({ [key]: e.target.value }); }}
        onKeyDown=${(e) => { if (e.key==="Enter") e.target.blur(); }} disabled=${saving} />
    </label>`;

  const num = (label, key, placeholder) => html`
    <label style=${S}><span style=${L}>${label}</span>
      <input type="text" inputmode="numeric" value=${cfg[key] ?? ""} style=${{ ...I, maxWidth: "100px" }} placeholder=${placeholder || ""}
        onBlur=${(e) => { const v = Number(e.target.value); if (!isNaN(v) && v !== cfg[key]) save({ [key]: v }); }}
        onKeyDown=${(e) => { if (e.key==="Enter") e.target.blur(); }} disabled=${saving} />
    </label>`;

  return html`
    <div style="padding:0.5rem 0;">
      <h4 style=${H}>General</h4>
      ${check("Enabled", "enabled")}
      ${text("Instance name", "instance_name", hostname())}
      ${hint("Identifies this piclaw instance in App Insights (cloud_RoleInstance). Blank = hostname.")}

      <h4 style=${H}>Azure Application Insights</h4>
      ${check("App Insights enabled", "appinsights_enabled")}
      ${text("Connection string (keychain entry)", "appinsights_keychain", "azure/appinsights-connection-string")}
      ${hint("Store the connection string as a keychain secret. Enter only the entry name here.")}
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

      ${msg && html`<div style=${{ marginTop: "0.75rem", fontSize: "0.8rem", color: msg==="Saved" ? "var(--accent-color)" : "var(--danger-color)" }}>${msg}</div>`}
    </div>`;
}

// hostname fallback for the placeholder
function hostname() { try { return location?.hostname || ""; } catch { return ""; } }

// Register pane
try {
  let reg, notify;
  const r = globalThis.__piclawSettingsPaneRegistry;
  if (r) { reg = r.registerSettingsPane; notify = r.notifySettingsPanesChanged; }
  if (!reg) { try { const m = require("../../components/settings/pane-registry.js"); reg = m.registerSettingsPane; notify = m.notifySettingsPanesChanged; } catch {} }
  if (reg) { reg({ id: "observability", label: "Observability", icon: ICON, component: ObservabilitySettings, order: 170 }); notify?.(); }
} catch {}
