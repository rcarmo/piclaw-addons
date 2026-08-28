// @ts-nocheck
const ADDON_ID = "usage-telemetry";
const API = `/agent/addons/api/${ADDON_ID}/config`;
const htm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact;
const html = htm?.html, useState = htm?.useState, useEffect = htm?.useEffect, useCallback = htm?.useCallback;
function Settings() {
  const [cfg, setCfg] = useState(null), [message, setMessage] = useState("");
  const load = useCallback(async () => { try { const r = await fetch(API); if (r.ok) setCfg(await r.json()); } catch { setMessage("Failed to load settings."); } }, []);
  useEffect(() => { load(); }, [load]);
  const save = async patch => { try { const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }); const value = await r.json(); if (value.ok) { setCfg(value.config); setMessage("Saved"); } else setMessage(value.error || "Save failed"); } catch { setMessage("Save failed"); } };
  if (!cfg) return html`<div style=${{padding:"1rem"}}>Loading…</div>`;
  const row = (label, node, hint) => html`<label style=${{display:"grid",gridTemplateColumns:"160px 1fr",gap:".5rem",alignItems:"center",margin:".6rem 0"}}><span style=${{color:"var(--text-secondary)"}}>${label}</span>${node}${hint && html`<small style=${{gridColumn:"2",color:"var(--text-secondary)"}}>${hint}</small>`}</label>`;
  const text = (label, key, hint) => row(label, html`<input value=${cfg[key] || ""} onBlur=${e => e.target.value !== cfg[key] && save({[key]:e.target.value})} />`, hint);
  const number = (label, key, hint) => row(label, html`<input type="number" value=${cfg[key]} onBlur=${e => save({[key]:Number(e.target.value)})} />`, hint);
  return html`<div style=${{padding:".5rem 0",maxWidth:"620px"}}><p style=${{color:"var(--text-secondary)"}}>Publishes local token and estimated-cost aggregates to Carbon. No provider account polling.</p>
    ${row("Enabled", html`<input type="checkbox" checked=${cfg.enabled} onChange=${e => save({enabled:e.target.checked})} />`)}
    ${text("Carbon host", "carbon_host", "Required. The add-on is idle until this is set.")}
    ${number("Carbon port", "carbon_port", "Carbon plaintext port (normally 2003).")}
    ${text("Metric prefix", "graphite_prefix", "Default: piclaw.usage")}
    ${text("Instance ID", "instance_id", "Blank uses the host name.")}
    ${number("Interval (minutes)", "interval_minutes", "1–60; default 15.")}
    ${text("Graphite render URL", "graphite_render_url", "Optional, used by the bundled SVG chart helper.")}
    ${message && html`<p style=${{color:"var(--accent-color)"}}>${message}</p>`}</div>`;
}
function register() { const r = globalThis.__piclawSettingsPaneRegistry; if (!html || !r?.registerSettingsPane) return; r.registerSettingsPane({ id: ADDON_ID, label: "Usage telemetry", component: Settings, order: 175 }); r.notifySettingsPanesChanged?.(); }
try { register(); setTimeout(register, 250); } catch {}
