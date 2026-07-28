// @ts-nocheck
const ADDON_ID = "remote-peer";
const API = `/agent/addons/api/${ADDON_ID}`;
const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
const html = preactHtm?.html;
const useState = preactHtm?.useState;
const useEffect = preactHtm?.useEffect;
const useCallback = preactHtm?.useCallback;
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

const ICON = HAS_RUNTIME
  ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 12h6"/></svg>`
  : null;

async function loadState() {
  const response = await fetch(`${API}/config`);
  if (!response.ok) throw new Error(`Load failed (${response.status})`);
  return await response.json();
}

async function saveConfig(patch) {
  const response = await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  let body = {};
  try { body = await response.json(); }
  catch (error) { console.debug("[remote-peer] config error response was not JSON", error); }
  if (!response.ok) throw new Error(body.error || `Save failed (${response.status})`);
  return body;
}

function RemotePeerSettings() {
  if (!HAS_RUNTIME) return null;
  const [state, setState] = useState(null);
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    try { setState(await loadState()); setMessage(""); }
    catch (error) { setMessage(error.message || String(error)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const save = useCallback(async (patch) => {
    try { await saveConfig(patch); await refresh(); setMessage("Saved. Restart Piclaw to apply runtime changes."); }
    catch (error) { setMessage(error.message || String(error)); }
  }, [refresh]);

  if (!state) return html`<div style="padding:1rem;color:var(--text-secondary)">${message || "Loading…"}</div>`;
  const cfg = state.config || {};
  const row = { display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.45rem 0" };
  const label = { minWidth: "150px", color: "var(--text-secondary)", fontSize: "0.85rem" };
  const input = { flex: 1, padding: "4px 8px", background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "4px" };

  return html`<div style="padding:0.5rem 0">
    <h4>Foundation</h4>
    <div style=${row}><span style=${label}>Fingerprint</span><code>${state.identity?.fingerprint || "unknown"}</code></div>
    <div style=${row}><span style=${label}>Schema</span><code>${state.database?.schema_version ?? "unknown"}</code></div>
    <label style=${row}><span style=${label}>Enabled</span><input type="checkbox" checked=${cfg.enabled === true} onChange=${e => save({ enabled: e.target.checked })}/></label>
    <label style=${row}><span style=${label}>Instance name</span><input style=${input} value=${cfg.instanceName || ""} onChange=${e => setState({ ...state, config: { ...cfg, instanceName: e.target.value } })} onBlur=${e => save({ instanceName: e.target.value })}/></label>
    <label style=${row}><span style=${label}>External URL</span><input style=${input} value=${cfg.externalUrl || ""} onChange=${e => setState({ ...state, config: { ...cfg, externalUrl: e.target.value } })} onBlur=${e => save({ externalUrl: e.target.value })}/></label>
    <label style=${row}><span style=${label}>Allow HTTP</span><input type="checkbox" checked=${cfg.allowHttp === true} onChange=${e => save({ allowHttp: e.target.checked })}/></label>
    <label style=${row}><span style=${label}>Allow private network</span><input type="checkbox" checked=${cfg.allowPrivateNetwork === true} onChange=${e => save({ allowPrivateNetwork: e.target.checked })}/></label>
    <p style="font-size:0.78rem;color:var(--text-secondary)">Pairing and messaging are added in subsequent versions. This release creates fresh add-on-owned state only.</p>
    ${message && html`<div style="font-size:0.8rem;color:var(--text-secondary)">${message}</div>`}
  </div>`;
}

try {
  if (HAS_RUNTIME) {
    const registry = globalThis.__piclawSettingsPaneRegistry;
    const register = registry?.registerSettingsPane || globalThis.__piclaw_web?.registerSettingsPane;
    if (register) {
      register({ id: ADDON_ID, label: "Remote Peer", icon: ICON, component: RemotePeerSettings, order: 190 });
      registry?.notifySettingsPanesChanged?.();
    }
  }
} catch (error) {
  console.warn("[remote-peer] failed to register Settings pane", error);
}
