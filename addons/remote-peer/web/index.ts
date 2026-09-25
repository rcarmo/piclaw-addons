// @ts-nocheck
import { remotePeerStyles } from "./styles.ts";
const ui = globalThis.__piclawPreactHtm || globalThis.__piclawPreact;
const html = ui?.html,
  useState = ui?.useState,
  useEffect = ui?.useEffect,
  useRef = ui?.useRef;
async function api(action, body) {
  const response = await fetch("/agent/addons/api/remote-peer/" + action, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Request failed");
  return data;
}

function peerPolicy(peer) {
  return { scope: peer.scope, modes: [...peer.modes], agents: [...peer.agents], files: peer.files === true };
}
function policyKey(policy) {
  return JSON.stringify([policy.scope, policy.modes, policy.agents, policy.files]);
}
function needsConfirmation(policy) {
  return !["none", "inbox-only"].includes(policy.scope) || policy.modes.some(m => m !== "queue") || policy.files;
}
function PeerPermissions({ peer, advertised, busy, enabled, onApply }) {
  const [draft, setDraft] = useState(() => peerPolicy(peer)),
    [savedPolicy, setSavedPolicy] = useState(() => peerPolicy(peer)),
    [savedEpoch, setSavedEpoch] = useState(peer.epoch),
    [editing, setEditing] = useState(false),
    [confirmation, setConfirmation] = useState(""),
    [saving, setSaving] = useState(false),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [remote, setRemote] = useState(null),
    [remoteBusy, setRemoteBusy] = useState(false),
    [remoteError, setRemoteError] = useState("");
  const prefix = "remote-peer-policy-" + peer.id;
  const saved = peerPolicy(peer);
  const baseline = policyKey(savedPolicy);
  const dirty = policyKey(draft) !== baseline;
  const conflict = editing && policyKey(saved) !== baseline;
  const locked = busy || saving || !enabled;
  const selectable = [...new Set([...draft.agents, ...advertised.map(a => a.alias)])];
  function reset(keepEditing) {
    setDraft(peerPolicy(peer)); setSavedPolicy(peerPolicy(peer)); setSavedEpoch(peer.epoch);
    setEditing(keepEditing); setConfirmation(""); setError(""); setStatus("");
  }
  function change(patch) { setDraft(current => ({ ...current, ...patch })); setConfirmation(""); setError(""); setStatus(""); }
  function toggle(key, value, checked) {
    change({ [key]: checked ? [...draft[key], value] : draft[key].filter(v => v !== value) });
  }
  async function apply() {
    if (locked || !dirty || conflict) return;
    setSaving(true); setError(""); setStatus("");
    try {
      const reloaded = await onApply(peer.id, draft, confirmation, savedPolicy, savedEpoch);
      setDraft(peerPolicy(reloaded)); setSavedPolicy(peerPolicy(reloaded)); setSavedEpoch(reloaded.epoch);
      setEditing(false); setConfirmation("");
      setStatus("Incoming permissions saved and reloaded. The peer must refresh its directory to see these changes.");
    } catch (e) { setError(e.message || "Could not apply permissions. Your edits are retained."); }
    finally { setSaving(false); }
  }
  async function refreshRemote() {
    setRemoteBusy(true); setRemoteError("");
    try {
      const data = await api("dashboard", { action: "remote_permissions", peer: peer.id });
      if (data.result?.peerId !== peer.id) throw Error("Peer changed while refreshing permissions.");
      setRemote(data.result);
    } catch (e) { setRemoteError(e.message || "Remote permissions unavailable."); }
    finally { setRemoteBusy(false); }
  }
  return html`<div class="remote-peer-permissions">
    <section class="settings-addon-section" aria-label="Incoming permissions">
      <h5>Incoming — what this peer may send to this instance</h5>
      <p class="settings-addon-help">You control these permissions for ${peer.alias} only. They do not grant remote tool execution.</p>
      <p class="remote-peer-saved">Saved: ${saved.scope} · ${saved.modes.join(", ")} · incoming files ${saved.files ? "enabled" : "disabled"}${saved.agents.length ? " · named agents: " + saved.agents.join(", ") : ""}</p>
      <p class="settings-addon-help" id=${prefix + "-limits"}>Protocol limits: up to 4 files, 16 MiB each, 32 MiB total. Enabling incoming files here lets this peer send files here; sending files to the peer depends on its own permissions.</p>
      ${!editing ? html`<button disabled=${locked} onClick=${() => reset(true)}>Edit incoming permissions</button>` : html`
        <fieldset disabled=${locked}>
          <legend>Incoming policy for ${peer.alias}</legend>
          <div class="settings-addon-field">
            <label class="settings-addon-label" for=${prefix + "-scope"}>Incoming scope</label>
            <select id=${prefix + "-scope"} class="settings-addon-control" value=${draft.scope} onChange=${e => change({ scope: e.target.value })}>
              <option value="none">None — deny messages</option><option value="inbox-only">Inbox only</option>
              <option value="named-agents">Inbox and selected advertised agents</option><option value="all-advertised">Inbox and all advertised agents</option>
            </select>
          </div>
          <fieldset><legend>Delivery modes</legend><div class="remote-peer-checks">
            ${["queue", "auto", "steer"].map(mode => html`<label><input type="checkbox" checked=${draft.modes.includes(mode)} onChange=${e => toggle("modes", mode, e.target.checked)} />${mode}</label>`)}
          </div>${!draft.modes.length && html`<p class="settings-addon-error" role="alert">Select at least one delivery mode.</p>`}</fieldset>
          <fieldset><legend>Named agents</legend>
            <p class="settings-addon-help">Selections apply to named-agent scope and are retained when changing only files or scope.</p>
            <div class="remote-peer-checks">${selectable.map(name => html`<label><input type="checkbox" disabled=${draft.scope !== "named-agents"} checked=${draft.agents.includes(name)} onChange=${e => toggle("agents", name, e.target.checked)} />@${name}${advertised.some(a => a.alias === name) ? "" : " (not currently advertised)"}</label>`)}</div>
            ${!selectable.length && html`<p class="settings-addon-help">No locally advertised agents.</p>`}
          </fieldset>
          <label class="remote-peer-check"><input type="checkbox" aria-describedby=${prefix + "-limits"} checked=${draft.files} onChange=${e => change({ files: e.target.checked })} /> Allow this peer to send files here</label>
          ${dirty && needsConfirmation(draft) && html`<div class="settings-addon-field">
            <label class="settings-addon-label" for=${prefix + "-confirmation"}>Confirm wider incoming access</label>
            <input id=${prefix + "-confirmation"} class="settings-addon-control" autocomplete="off" value=${confirmation} placeholder="ALLOW REMOTE ACCESS" onInput=${e => setConfirmation(e.target.value)} aria-describedby=${prefix + "-confirm-help"} />
            <span id=${prefix + "-confirm-help"} class="settings-addon-help">Type ALLOW REMOTE ACCESS to apply this broader policy.</span>
          </div>`}
        </fieldset>
        ${conflict && html`<p class="settings-addon-error" role="alert">Saved permissions changed while you were editing. Revert to reload them before applying.</p>`}
        <p class="settings-addon-status" role="status">${saving ? "Applying incoming permissions…" : dirty ? "Unsaved changes" : "No unsaved changes"}</p>
        <div class="settings-addon-actions">
          <button data-settings-button="primary" disabled=${locked || !dirty || conflict || !draft.modes.length || (needsConfirmation(draft) && confirmation !== "ALLOW REMOTE ACCESS")} onClick=${apply}>Apply</button>
          <button disabled=${saving} onClick=${() => reset(true)}>Revert</button>
          <button disabled=${saving} onClick=${() => reset(false)}>Cancel</button>
        </div>`}
      ${error && html`<p class="settings-addon-error" role="alert">${error} Your edits are retained; retry or Revert.</p>`}
      ${status && html`<p class="settings-addon-status" role="status">${status}</p>`}
    </section>
    <section class="settings-addon-section" aria-label="Outgoing permissions">
      <h5>Outgoing — what this instance may send to this peer</h5>
      <p class="settings-addon-help">Read-only advertisement controlled by ${peer.alias}. Local incoming edits do not enable files at the destination.</p>
      <button disabled=${busy || remoteBusy || !enabled} onClick=${refreshRemote}>${remoteBusy ? "Refreshing remote permissions…" : "Refresh remote permissions"}</button>
      <p role="status" class="settings-addon-status">${remote ? "Last fetched " + new Date(remote.fetchedAt).toLocaleString() + (remoteError || !enabled || Date.now() - Date.parse(remote.fetchedAt) > 30000 ? " — stale; refresh required." : " — snapshot only; sending rechecks permissions.") : "Remote permissions unavailable — not fetched."}</p>
      ${remoteError && html`<p class="settings-addon-error" role="alert">Remote permissions unavailable: ${remoteError}${remote ? " Last fetched snapshot is stale." : ""}</p>`}
      ${remote && html`<div class="remote-peer-saved"><p>Remote inbox: ${remote.inbox ? "allowed" : "not advertised"} · modes: ${remote.modes.join(", ")} · outgoing files ${remote.files ? "enabled" : "disabled"}</p>
        <p>Advertised remote agents: ${remote.agents.length ? remote.agents.map(a => "@" + a.name + " (" + a.modes.join(", ") + ")").join("; ") : "none"}</p>
        <p class="settings-addon-help">Local protocol sending limits: ${remote.limits.maxFiles} files, ${remote.limits.maxFileBytes / 1048576} MiB each, ${remote.limits.maxTotalBytes / 1048576} MiB total.</p></div>`}
    </section>
  </div>`;
}
function RemotePeerSettings() {
  const dashboardGeneration = useRef(0);
  const policySaving = useRef(false);
  const [state, setState] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [client, setClient] = useState(""),
    [alias, setAlias] = useState(""),
    [ticket, setTicket] = useState(""),
    [localTicket, setLocalTicket] = useState(""),
    [relayText, setRelayText] = useState("");
  async function refresh() {
    if (policySaving.current) return;
    const generation = ++dashboardGeneration.current;
    try {
      const value = await api("dashboard");
      if (generation !== dashboardGeneration.current) return;
      setState(value);
      setRelayText(
        (previous) => previous || JSON.stringify(value.config.relays, null, 2),
      );
    } catch (e) {
      if (generation === dashboardGeneration.current) setError(e.message);
    }
  }
  async function applyPolicy(peerId, draft, confirmation, expectedPolicy, expectedEpoch) {
    if (policySaving.current) throw Error("A permission update is already in progress.");
    policySaving.current = true;
    ++dashboardGeneration.current;
    setBusy(true);
    try {
      await api("dashboard", { action: "policy", peer: peerId, ...draft, confirmation, expected_policy: expectedPolicy, expected_epoch: expectedEpoch });
      const generation = ++dashboardGeneration.current;
      const value = await api("dashboard");
      const peer = value.peers.find(p => p.id === peerId && p.status === "paired");
      if (!peer || peer.epoch !== expectedEpoch || policyKey(peerPolicy(peer)) !== policyKey(draft)) throw Error("Saved policy could not be verified.");
      if (generation === dashboardGeneration.current) setState(value);
      return peer;
    } finally { policySaving.current = false; setBusy(false); }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, []);
  async function run(body) {
    setBusy(true);
    setError("");
    try {
      const value = await api("dashboard", body);
      setState(value);
      if (body.action === "ticket") setLocalTicket(value.result.ticket);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function config(patch) {
    setBusy(true);
    setError("");
    // Keep controlled fields stable while endpoint/discovery resources restart.
    setState((current) =>
      current
        ? { ...current, config: { ...current.config, ...patch } }
        : current,
    );
    try {
      const result = await api("config", patch);
      setState((current) =>
        current ? { ...current, config: result.config } : current,
      );
      await refresh();
    } catch (e) {
      setError(e.message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  const confirm = (peer) =>
    prompt(
      "Verify the client ID with its owner. Paste the complete ID to confirm:\n" +
        peer.clientId,
    ) || "";
  const copy = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      prompt("Copy this value:", value);
    }
  };
  if (!state) return html`<p>${error || "Loading Remote Peer…"}</p>`;
  const c = state.config;
  return html`<div class="remote-peer-settings">
    <style>${remotePeerStyles}</style>
    <section class="remote-peer-section">
      <h4>Iroh Remote Peer</h4>
      <p class="remote-peer-description">
        Fresh client identity and Iroh-only peer connections. Older HTTP peers
        and databases are not supported.
      </p>
      <div class="remote-peer-row">
        <label class="remote-peer-check"
          ><input
            type="checkbox"
            checked=${c.enabled}
            disabled=${busy}
            onChange=${(e) => config({ enabled: e.target.checked })}
          />
          Enable Remote Peer</label>
      </div>
      <div class="settings-addon-field">
        <label class="settings-addon-label" for="remote-peer-instance-name">Instance name</label>
        <input id="remote-peer-instance-name" class="settings-addon-control" type="text"
          placeholder="Instance name"
          defaultValue=${c.instanceName}
          onBlur=${(e) => {
            if (e.target.value !== c.instanceName)
              config({ instanceName: e.target.value });
          }}
        />
      </div>
      <span class="settings-addon-label">Your client ID</span>
      <div class="remote-peer-identity">
        <code class="remote-peer-id">${state.identity.clientId}</code>
        <div class="remote-peer-actions"><button onClick=${() => copy(state.identity.clientId)}>Copy ID</button>
        <button
          disabled=${busy ||
          state.peers.some((peer) => peer.status !== "revoked")}
          onClick=${() => {
            const confirmation =
              prompt(
                `This creates a new client ID and clears all fresh Iroh trust, queues and advertised agents. Legacy files are untouched. Paste the current ID to confirm:\n${state.identity.clientId}`,
              ) || "";
            run({ action: "rotate", confirmation });
          }}
        >
          Rotate identity
        </button></div>
      </div>
      <p class="remote-peer-description">
        Rotation requires every peer and pending request to be revoked first.
      </p>
      <p class="settings-addon-status" role="status">
        ${state.transport.active ? "Listening" : "Stopped"} ·
        ${state.transport.relay ? "Relay connected" : "No relay yet"} · last
        path ${state.transport.lastPath || "none"}
      </p>
      ${state.transport.error &&
      html`<p class="settings-addon-error" role="alert">${state.transport.error}</p>`}
      <label class="remote-peer-check"
        ><input
          type="checkbox"
          checked=${c.addressLookup}
          disabled=${busy}
          onChange=${(e) => config({ addressLookup: e.target.checked })}
        />
        Internet address lookup for pasted IDs</label
      >
      <p class="remote-peer-description">
        When enabled, Iroh publishes and resolves endpoint address records
        through n0 discovery services. This does not grant trust. When off, use
        a ticket or opt-in nearby discovery.
      </p>
      <details>
        <summary>Advanced: endpoint ticket</summary>
        <button
          disabled=${busy || !c.enabled}
          onClick=${() => run({ action: "ticket" })}
        >
          Generate ticket</button
        >${localTicket &&
        html`<div class="settings-addon-field"><label class="settings-addon-label" for="remote-peer-local-ticket">Local endpoint ticket</label><textarea
            id="remote-peer-local-ticket" class="settings-addon-control"
            readonly
            rows="3"
            value=${localTicket}
          /></div><button onClick=${() => copy(localTicket)}>Copy ticket</button>`}
      </details>
    </section>
    <section class="remote-peer-section">
      <h4>Add peer</h4>
      <div class="settings-addon-field">
        <label class="settings-addon-label" for="remote-peer-client-id">Peer client ID</label>
        <input id="remote-peer-client-id" class="settings-addon-control" type="text"
          aria-label="Peer client ID"
          value=${client}
          onInput=${(e) => setClient(e.target.value)}
          placeholder="Paste client ID: PCL1-…"
        /></div><div class="settings-addon-field">
        <label class="settings-addon-label" for="remote-peer-alias">Peer alias</label>
        <input id="remote-peer-alias" class="settings-addon-control" type="text"
          aria-label="Peer alias"
          value=${alias}
          onInput=${(e) => setAlias(e.target.value)}
          placeholder="Local alias (optional)"
        />
      </div>
      <details>
        <summary>Optional endpoint ticket</summary>
        <div class="settings-addon-field"><label class="settings-addon-label" for="remote-peer-ticket">Peer endpoint ticket</label><textarea
          id="remote-peer-ticket" class="settings-addon-control"
          rows="2"
          value=${ticket}
          onInput=${(e) => setTicket(e.target.value)}
        /></div>
      </details>
      <button data-settings-button="primary"
        disabled=${busy || !c.enabled || !client.trim()}
        onClick=${() =>
          run({
            action: "pair",
            client_id: client.trim(),
            ...(alias ? { alias } : {}),
            ...(ticket ? { ticket } : {}),
          })}
      >
        Request pairing
      </button>
      <p class="remote-peer-description">
        The other instance must explicitly accept. Knowing a client ID never
        grants access.
      </p>
    </section>
    <section class="remote-peer-section">
      <h4>Local discovery</h4>
      <label class="remote-peer-check"
        ><input
          type="checkbox"
          checked=${c.mdnsEnabled}
          disabled=${busy}
          onChange=${(e) => config({ mdnsEnabled: e.target.checked })}
        />
        Enable mDNS on this network (off by default)</label
      >
      <p class="remote-peer-description">
        Advertises the public client ID locally and lists untrusted nearby
        candidates. Does not auto-pair.
      </p>
      <div class="settings-addon-field">
      <label class="settings-addon-label" for="remote-peer-interface">IPv4 interface (optional)</label>
      <input id="remote-peer-interface" class="settings-addon-control" type="text"
        placeholder="IPv4 interface (optional)"
        defaultValue=${c.mdnsInterface}
        onBlur=${(e) => {
          if (e.target.value !== c.mdnsInterface)
            config({ mdnsInterface: e.target.value });
        }}
      />
      </div>
      <p class="settings-addon-status" role="status">
        ${state.discovery.active ? "Discovery active" : "Discovery stopped"}
        ${state.discovery.error || ""}
      </p>
      ${state.candidates.map(
        (candidate) =>
          html`<div class="remote-peer-row">
            <span>${candidate.name}</span><code>${candidate.clientId}</code
            ><button
              disabled=${busy}
              onClick=${() => {
                setClient(candidate.clientId);
              }}
            >
              Use ID
            </button>
          </div>`,
      )}
    </section>
    <section class="remote-peer-section">
      <h4>Peers and requests</h4>
      ${!state.peers.length && html`<p>No paired clients.</p>`}
      ${state.peers.map(
        (peer) =>
          html`<div class="remote-peer-card" key=${peer.id + ":" + peer.epoch} data-peer-id=${peer.id}>
            <header class="remote-peer-card-header"><strong>${peer.alias}</strong><span class="remote-peer-name">${peer.name}</span><span class="remote-peer-state">${peer.status}</span></header>
            <code class="remote-peer-id">${peer.clientId}</code>
            <div class="remote-peer-row">
              ${peer.status === "incoming" &&
              html`<button
                disabled=${busy}
                onClick=${() =>
                  run({
                    action: "accept",
                    peer: peer.id,
                    confirmation: confirm(peer),
                  })}
              >
                Accept
              </button>`}
              ${["incoming", "outgoing"].includes(peer.status) &&
              html`<button
                disabled=${busy}
                onClick=${() => run({ action: "deny", peer: peer.id })}
              >
                Deny / cancel
              </button>`}
              ${peer.status === "paired" &&
              html`<button
                  disabled=${busy}
                  onClick=${() => run({ action: "ping", peer: peer.id })}
                >
                  Ping</button
                ><button
                  disabled=${busy}
                  onClick=${() =>
                    run({
                      action: "revoke",
                      peer: peer.id,
                      confirmation: confirm(peer),
                    })}
                >
                  Revoke
                </button>`}
              ${peer.status === "revoked" &&
              html`<button
                disabled=${busy}
                onClick=${() =>
                  run({
                    action: "forget",
                    peer: peer.id,
                    confirmation: confirm(peer),
                  })}
              >
                Remove revoked record
              </button>`}
              <button
                disabled=${busy}
                onClick=${() => {
                  const name = prompt("Local alias", peer.alias);
                  if (name)
                    run({ action: "alias", peer: peer.id, alias: name });
                }}
              >
                Rename
              </button>
            </div>
            ${peer.status === "paired" &&
            html`<${PeerPermissions} peer=${peer} advertised=${state.advertised} busy=${busy} enabled=${c.enabled} onApply=${applyPolicy} />`}
          </div>`,
      )}
    </section>
    <section class="remote-peer-section">
      <h4>Advertised agents</h4>
      ${!state.advertised.length && html`<p class="settings-addon-help">No local agents advertised.</p>`}
      ${state.advertised.map(
        (a) =>
          html`<div class="remote-peer-row">
            @${a.alias} → ${a.local_agent}<button
              onClick=${() => run({ action: "unadvertise", alias: a.alias })}
            >
              Hide
            </button>
          </div>`,
      )}
      <div class="settings-addon-field">
      <label class="settings-addon-label" for="remote-peer-advertise">Advertise a local agent</label>
      <select id="remote-peer-advertise" class="settings-addon-control"
        defaultValue=""
        onChange=${(e) => {
          const local = e.target.value;
          if (!local) return;
          const name = prompt("Public alias", local);
          if (name)
            run({
              action: "advertise",
              local_agent: local,
              alias: name,
              modes: ["queue"],
            });
          e.target.value = "";
        }}
      >
        <option value="">Advertise a local agent…</option>
        ${state.localAgents.map(
          (a) => html`<option value=${a.agent_name}>${a.agent_name}</option>`,
        )}
      </select>
      </div>
    </section>
    <section class="remote-peer-section">
      <h4>Relays</h4>
      <div class="settings-addon-field">
      <label class="settings-addon-label" for="remote-peer-relay-mode">Relay mode</label>
      <select id="remote-peer-relay-mode" class="settings-addon-control"
        value=${c.relayMode}
        disabled=${busy}
        onChange=${(e) => {
          try {
            config({
              relayMode: e.target.value,
              relays: JSON.parse(relayText || "[]"),
            });
          } catch {
            setError("Invalid relay JSON");
          }
        }}
      >
        <option value="n0">n0 relays</option>
        <option value="custom">Custom relays</option>
        <option value="disabled">No relays (direct only)</option>
      </select>
      </div>
      <p id="remote-peer-relay-help" class="settings-addon-help">
        Custom list: HTTPS URL and optional authTokenKeychain reference. Never
        paste a secret here.
      </p>
      <div class="settings-addon-field">
      <label class="settings-addon-label" for="remote-peer-relays">Custom relays (JSON)</label>
      <textarea id="remote-peer-relays" class="settings-addon-control" aria-describedby="remote-peer-relay-help"
        rows="3"
        value=${relayText}
        onInput=${(e) => setRelayText(e.target.value)}
      /></div><button
        disabled=${busy}
        onClick=${() => {
          try {
            config({ relays: JSON.parse(relayText) });
          } catch {
            setError("Invalid relay JSON");
          }
        }}
      >
        Save relay list
      </button>
    </section>
    <section class="remote-peer-section">
      <h4>Delivery</h4>
      ${!state.messages.length && html`<p class="settings-addon-help">No recent deliveries.</p>`}
      ${state.messages.map(
        (m) =>
          html`<div class="remote-peer-row">
            <code>${m.id}</code> ${m.status}
            ${m.error || ""}${m.status === "failed" &&
            html`<button
              disabled=${busy}
              onClick=${() => run({ action: "retry", message_id: m.id })}
            >
              Retry
            </button>`}
          </div>`,
      )}
    </section>
    <section class="remote-peer-section">
      <h4>Mediated work</h4>
      <p class="remote-peer-description">Remote requests never execute tools automatically.</p>
      ${!state.work.some(w => w.direction === "inbound" && ["pending", "response-pending"].includes(w.status)) && html`<p class="settings-addon-help">No requests awaiting review.</p>`}
      ${state.work
        .filter(
          (w) =>
            w.direction === "inbound" &&
            ["pending", "response-pending"].includes(w.status),
        )
        .map(
          (w) =>
            html`<div class="remote-peer-card">
              <code>${w.id}</code>
              <pre class="remote-peer-work-prompt">${w.data.prompt}</pre>
              <div class="remote-peer-actions"><button
                disabled=${busy}
                onClick=${() => {
                  const result = prompt("Reviewed result");
                  if (result !== null)
                    run({
                      action: "work_review",
                      request_id: w.id,
                      result,
                      capabilities: [],
                      approve: true,
                    });
                }}
              >
                Approve with reviewed result</button
              ><button
                disabled=${busy}
                onClick=${() =>
                  run({
                    action: "work_review",
                    request_id: w.id,
                    result: "Rejected by operator",
                    capabilities: [],
                    approve: false,
                  })}
              >
                Reject
              </button></div>
            </div>`,
        )}
    </section>
    ${error && html`<p class="settings-addon-error" role="alert">${error}</p>`}
  </div>`;
}
if (html && useState && useEffect) {
  const registry = globalThis.__piclawSettingsPaneRegistry;
  const register =
    registry?.registerSettingsPane ||
    globalThis.__piclaw_web?.registerSettingsPane;
  register?.({
    id: "remote-peer",
    label: "Remote Peer",
    icon: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M12 8v5M5 16v-3h14v3"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/></svg>`,
    component: RemotePeerSettings,
    order: 190,
  });
  registry?.notifySettingsPanesChanged?.();
}
