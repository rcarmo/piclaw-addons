// @ts-nocheck
const ADDON_ID = "remote-peer";
const API = `/agent/addons/api/${ADDON_ID}`;
const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
const html = preactHtm?.html;
const useState = preactHtm?.useState;
const useEffect = preactHtm?.useEffect;
const useCallback = preactHtm?.useCallback;
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

async function api(action, method = "GET", payload) {
  const response = await fetch(`${API}/${action}`, {
    method,
    ...(payload === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
  });
  let body = {};
  try { body = await response.json(); }
  catch (error) { console.debug("[remote-peer] non-JSON API response", error); }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function RemotePeerSettings() {
  if (!HAS_RUNTIME) return null;
  const [dashboard, setDashboard] = useState(null);
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pairUrl, setPairUrl] = useState("");
  const [agentForm, setAgentForm] = useState({ local_agent: "", alias: "", modes: ["queue"] });

  const refresh = useCallback(async () => {
    try {
      const [dash, foundation] = await Promise.all([api("dashboard"), api("config")]);
      setDashboard(dash);
      setConfig(foundation.config || {});
      setMessage("");
    } catch (error) { setMessage(error.message || String(error)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const mutate = useCallback(async (payload, success = "Updated.") => {
    setBusy(true); setMessage("");
    try { setDashboard(await api("dashboard", "POST", payload)); setMessage(success); }
    catch (error) { setMessage(error.message || String(error)); }
    finally { setBusy(false); }
  }, []);

  const saveConfig = useCallback(async (patch) => {
    setBusy(true); setMessage("");
    try {
      const result = await api("config", "POST", patch);
      setConfig(result.config);
      await refresh();
      setMessage("Saved. Restart Piclaw after changing runtime endpoint settings.");
    } catch (error) { setMessage(error.message || String(error)); }
    finally { setBusy(false); }
  }, [refresh]);

  if (!dashboard || !config) return html`<div style="padding:1rem;color:var(--text-secondary)">${message || "Loading Remote Peer…"}</div>`;

  const C = {
    section: { margin: "0 0 0.85rem", padding: "0.8rem", border: "1px solid var(--border-color)", borderRadius: "9px", background: "color-mix(in srgb, var(--bg-secondary) 76%, transparent)" },
    title: { margin: "0 0 0.65rem", fontSize: "0.9rem", letterSpacing: "0.01em" },
    grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: "0.5rem" },
    stat: { padding: "0.55rem", border: "1px solid var(--border-color)", borderRadius: "7px", background: "var(--bg-primary)" },
    label: { display: "block", color: "var(--text-secondary)", fontSize: "0.69rem", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.2rem" },
    row: { display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.45rem 0", flexWrap: "wrap" },
    input: { flex: 1, minWidth: "150px", padding: "5px 8px", color: "var(--text-primary)", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "6px" },
    button: { padding: "5px 10px", border: "1px solid var(--border-color)", borderRadius: "6px", background: "var(--bg-secondary)", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.78rem" },
    danger: { padding: "5px 10px", border: "1px solid color-mix(in srgb,var(--danger-color,#dc2626) 55%,var(--border-color))", borderRadius: "6px", background: "transparent", color: "var(--danger-color,#dc2626)", cursor: "pointer", fontSize: "0.78rem" },
    muted: { color: "var(--text-secondary)", fontSize: "0.75rem" },
    code: { fontFamily: "var(--font-mono,ui-monospace,monospace)", fontSize: "0.75rem", overflowWrap: "anywhere" },
  };
  const health = dashboard.health || {};
  const identity = dashboard.foundation?.identity || {};
  const statusColor = health.enabled && health.database === "ok" ? "var(--accent-color,#0f766e)" : "var(--danger-color,#dc2626)";
  const confirmFingerprint = (verb, item) => globalThis.prompt?.(`${verb} peer?\n\nFingerprint: ${item.fingerprint}\nOrigin: ${item.origin || "unknown"}\n\nType the fingerprint to confirm:`) || "";
  const confirmRisk = () => globalThis.prompt?.("This grants broader remote access. Type ALLOW REMOTE ACCESS to confirm:") || "";

  const peerCard = (peer) => html`<div style=${{ ...C.stat, marginBottom: "0.55rem" }}>
    <div style="display:flex;justify-content:space-between;gap:.5rem;align-items:flex-start">
      <div><strong>${peer.peer_alias}</strong> <span style=${C.muted}>${peer.display_name || ""}</span><div style=${C.code}>${peer.fingerprint}</div></div>
      <span style=${{ fontSize: "0.68rem", color: peer.status === "paired" ? statusColor : "var(--text-secondary)" }}>${peer.status}</span>
    </div>
    <div style=${{ ...C.row, marginTop: "0.65rem" }}>
      <select style=${C.input} value=${peer.messaging_scope} onChange=${e => {
        const scope = e.target.value; const confirmation = scope === "all-advertised" ? confirmRisk() : "";
        mutate({ action: "set_policy", peer: peer.instance_id, scope, mode_ceiling: peer.mode_ceiling, agents: peer.allowed_agents, confirmation }, "Peer scope updated.");
      }} disabled=${busy}>
        <option value="none">No messaging</option><option value="inbox-only">Inbox only</option><option value="named-agents">Named agents</option><option value="all-advertised">All advertised</option>
      </select>
      <select style=${C.input} value=${peer.mode_ceiling} onChange=${e => {
        const mode_ceiling = e.target.value; const confirmation = mode_ceiling === "queue-auto-steer" ? confirmRisk() : "";
        mutate({ action: "set_policy", peer: peer.instance_id, scope: peer.messaging_scope, mode_ceiling, agents: peer.allowed_agents, confirmation }, "Mode ceiling updated.");
      }} disabled=${busy}>
        <option value="queue">Queue</option><option value="queue-auto">Queue + auto</option><option value="queue-auto-steer">Queue + auto + steer</option>
      </select>
      <button style=${C.button} onClick=${() => mutate({ action: "set_alias", peer: peer.instance_id, alias: globalThis.prompt?.("New local peer alias:", peer.peer_alias) || "" }, "Alias updated.")} disabled=${busy}>Alias</button>
      <button style=${C.danger} onClick=${() => mutate({ action: "revoke", peer: peer.instance_id, confirmation: confirmFingerprint("Revoke", peer) }, "Peer revoked.")} disabled=${busy || peer.status !== "paired"}>Revoke</button>
    </div>
    <div style=${C.muted}>${peer.origin || "No origin"} · last seen ${peer.last_seen_at || "never"}</div>
  </div>`;

  return html`<div style="padding:.35rem 0;max-width:920px">
    <section style=${C.section}>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem"><h4 style=${C.title}>Health & identity</h4><button style=${C.button} onClick=${refresh} disabled=${busy}>Refresh</button></div>
      <div style=${C.grid}>
        <div style=${C.stat}><span style=${C.label}>Runtime</span><strong style=${{ color: statusColor }}>${health.enabled ? "Enabled" : "Disabled"}</strong></div>
        <div style=${C.stat}><span style=${C.label}>Database</span><strong>${health.database}</strong> · schema ${dashboard.foundation?.database?.schema_version}</div>
        <div style=${C.stat}><span style=${C.label}>Peers</span><strong>${health.paired}</strong> paired · ${health.pending} pending</div>
        <div style=${C.stat}><span style=${C.label}>Failed receipts</span><strong>${health.failed_receipts}</strong></div>
      </div>
      <div style=${{ ...C.row, marginTop: ".65rem" }}><span style=${C.label}>Fingerprint</span><code style=${C.code}>${identity.fingerprint}</code><button style=${C.danger} onClick=${() => mutate({ action: "rotate_identity", confirmation: globalThis.prompt?.(`Revoke every paired peer first. Then type ROTATE ${identity.fingerprint} to confirm:`) || "" }, "Identity rotated. Restart Piclaw and re-pair every peer.")} disabled=${busy || health.paired > 0}>Rotate key</button></div>
      <div style=${C.row}><label><input type="checkbox" checked=${config.enabled === true} onChange=${e => saveConfig({ enabled: e.target.checked })} disabled=${busy}/> Enabled</label><input style=${C.input} value=${config.instanceName || ""} placeholder="Instance name" onBlur=${e => saveConfig({ instanceName: e.target.value })}/><input style=${C.input} value=${config.externalUrl || ""} placeholder="https://peer.example" onBlur=${e => saveConfig({ externalUrl: e.target.value })}/></div>
      <div style=${C.row}><label><input type="checkbox" checked=${config.allowHttp === true} onChange=${e => saveConfig({ allowHttp: e.target.checked })}/> Allow HTTP</label><label><input type="checkbox" checked=${config.allowPrivateNetwork === true} onChange=${e => saveConfig({ allowPrivateNetwork: e.target.checked })}/> Allow private network</label></div>
    </section>

    <section style=${C.section}>
      <h4 style=${C.title}>Pairing & peers</h4>
      <div style=${C.row}><input style=${C.input} value=${pairUrl} onInput=${e => setPairUrl(e.target.value)} placeholder="https://peer.example"/><button style=${C.button} onClick=${() => mutate({ action: "pair_request", url: pairUrl }, "Pair request sent.")} disabled=${busy || !pairUrl.trim()}>Request pairing</button></div>
      ${(dashboard.pending || []).map(item => html`<div style=${{ ...C.stat, margin: ".5rem 0", borderColor: "color-mix(in srgb,var(--accent-color,#0f766e) 40%,var(--border-color))" }}>
        <strong>${item.display_name || "Unnamed peer"}</strong><div style=${C.code}>${item.fingerprint}</div><div style=${C.muted}>${item.origin} · expires ${item.expires_at}</div>
        <div style=${C.row}><button style=${C.button} onClick=${() => mutate({ action: "accept_pair", request_id: item.request_id, confirmation: confirmFingerprint("Accept", item) }, "Peer accepted.")} disabled=${busy}>Accept</button><button style=${C.danger} onClick=${() => mutate({ action: "deny_pair", request_id: item.request_id }, "Pair request denied.")} disabled=${busy}>Deny</button></div>
      </div>`)}
      ${(dashboard.peers || []).map(peerCard)}
      ${!(dashboard.pending || []).length && !(dashboard.peers || []).length && html`<div style=${C.muted}>No pair requests or peer records.</div>`}
    </section>

    <section style=${C.section}>
      <h4 style=${C.title}>Advertised agents & delivery</h4>
      <div style=${C.row}>
        <select style=${C.input} value=${agentForm.local_agent} onChange=${e => setAgentForm({ ...agentForm, local_agent: e.target.value, alias: agentForm.alias || e.target.value })}><option value="">Choose local agent…</option>${(dashboard.local_agents || []).map(agent => html`<option value=${agent.agent_name}>${agent.agent_name}${agent.active ? " · active" : ""}</option>`)}</select>
        <input style=${C.input} value=${agentForm.alias} onInput=${e => setAgentForm({ ...agentForm, alias: e.target.value })} placeholder="Public alias"/>
        <button style=${C.button} onClick=${() => mutate({ action: "advertise_agent", ...agentForm }, "Agent advertised.")} disabled=${busy || !agentForm.local_agent}>Advertise</button>
      </div>
      ${(dashboard.advertised_agents || []).map(agent => html`<div style=${{ ...C.row, ...C.stat }}><strong>@${agent.alias}</strong><span style=${C.muted}>→ ${agent.local_agent} · ${agent.allowed_modes.join(", ")}</span><button style=${C.danger} onClick=${() => mutate({ action: "unadvertise_agent", alias: agent.alias }, "Agent hidden.")} disabled=${busy}>Hide</button></div>`)}
      ${health.failed_receipts > 0 && html`<div style=${{ ...C.stat, marginTop: ".6rem", borderColor: "color-mix(in srgb,var(--danger-color,#dc2626) 45%,var(--border-color))" }}><strong>${health.failed_receipts} failed delivery receipt(s)</strong><div style=${C.muted}>Inspect details with remote_peer({ action: "message_failures" }).</div></div>`}
    </section>
    ${message && html`<div role="status" style=${{ padding: ".55rem .7rem", borderRadius: "7px", background: "var(--bg-secondary)", color: /failed|requires|invalid|error/i.test(message) ? "var(--danger-color,#dc2626)" : "var(--accent-color,#0f766e)", fontSize: ".8rem" }}>${message}</div>`}
  </div>`;
}

try {
  if (HAS_RUNTIME) {
    const registry = globalThis.__piclawSettingsPaneRegistry;
    const register = registry?.registerSettingsPane || globalThis.__piclaw_web?.registerSettingsPane;
    if (register) {
      register({ id: ADDON_ID, label: "Remote Peer", component: RemotePeerSettings, order: 190 });
      registry?.notifySettingsPanesChanged?.();
    }
  }
} catch (error) {
  console.warn("[remote-peer] failed to register Settings pane", error);
}
