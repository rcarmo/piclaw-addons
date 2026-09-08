// @ts-nocheck
const ui = globalThis.__piclawPreactHtm || globalThis.__piclawPreact;
const html = ui?.html,
  useState = ui?.useState,
  useEffect = ui?.useEffect;
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
function RemotePeerSettings() {
  const [state, setState] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [client, setClient] = useState(""),
    [alias, setAlias] = useState(""),
    [ticket, setTicket] = useState(""),
    [localTicket, setLocalTicket] = useState(""),
    [relayText, setRelayText] = useState("");
  async function refresh() {
    try {
      const value = await api("dashboard");
      setState(value);
      setRelayText(
        (previous) => previous || JSON.stringify(value.config.relays, null, 2),
      );
    } catch (e) {
      setError(e.message);
    }
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
    try {
      await api("config", patch);
      await refresh();
    } catch (e) {
      setError(e.message);
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
  const box = {
    border: "1px solid var(--border-color)",
    borderRadius: "8px",
    padding: "12px",
    marginBottom: "12px",
  };
  const row = {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
    alignItems: "center",
    margin: "8px 0",
  };
  const input = {
    background: "var(--bg-primary)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-color)",
    padding: "6px",
    borderRadius: "5px",
    minWidth: "180px",
    flex: 1,
  };
  return html`<div style="max-width:900px">
    <section style=${box}>
      <h4>Iroh Remote Peer</h4>
      <p>
        Fresh client identity and Iroh-only peer connections. Older HTTP peers
        and databases are not supported.
      </p>
      <div style=${row}>
        <label
          ><input
            type="checkbox"
            checked=${c.enabled}
            disabled=${busy}
            onChange=${(e) => config({ enabled: e.target.checked })}
          />
          Enable Remote Peer</label
        ><input
          style=${input}
          placeholder="Instance name"
          defaultValue=${c.instanceName}
          onBlur=${(e) => {
            if (e.target.value !== c.instanceName)
              config({ instanceName: e.target.value });
          }}
        />
      </div>
      <label>Your client ID</label>
      <div style=${row}>
        <code style="overflow-wrap:anywhere">${state.identity.clientId}</code
        ><button onClick=${() => copy(state.identity.clientId)}>Copy ID</button>
      </div>
      <p>
        ${state.transport.active ? "Listening" : "Stopped"} ·
        ${state.transport.relay ? "Relay connected" : "No relay yet"} · last
        path ${state.transport.lastPath || "none"}
      </p>
      ${state.transport.error &&
      html`<p role="alert">${state.transport.error}</p>`}
      <label
        ><input
          type="checkbox"
          checked=${c.addressLookup}
          disabled=${busy}
          onChange=${(e) => config({ addressLookup: e.target.checked })}
        />
        Internet address lookup for pasted IDs</label
      >
      <p>
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
        html`<textarea
            readonly
            rows="3"
            style=${input}
            value=${localTicket}
          /><button onClick=${() => copy(localTicket)}>Copy ticket</button>`}
      </details>
    </section>
    <section style=${box}>
      <h4>Add peer</h4>
      <div style=${row}>
        <input
          aria-label="Peer client ID"
          style=${input}
          value=${client}
          onInput=${(e) => setClient(e.target.value)}
          placeholder="Paste client ID: PCL1-…"
        /><input
          aria-label="Peer alias"
          style=${input}
          value=${alias}
          onInput=${(e) => setAlias(e.target.value)}
          placeholder="Local alias (optional)"
        />
      </div>
      <details>
        <summary>Optional endpoint ticket</summary>
        <textarea
          style=${input}
          rows="2"
          value=${ticket}
          onInput=${(e) => setTicket(e.target.value)}
        />
      </details>
      <button
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
      <p>
        The other instance must explicitly accept. Knowing a client ID never
        grants access.
      </p>
    </section>
    <section style=${box}>
      <h4>Local discovery</h4>
      <label
        ><input
          type="checkbox"
          checked=${c.mdnsEnabled}
          disabled=${busy}
          onChange=${(e) => config({ mdnsEnabled: e.target.checked })}
        />
        Enable mDNS on this network (off by default)</label
      >
      <p>
        Advertises the public client ID locally and lists untrusted nearby
        candidates. Does not auto-pair.
      </p>
      <input
        style=${input}
        placeholder="IPv4 interface (optional)"
        defaultValue=${c.mdnsInterface}
        onBlur=${(e) => {
          if (e.target.value !== c.mdnsInterface)
            config({ mdnsInterface: e.target.value });
        }}
      />
      <p>
        ${state.discovery.active ? "Discovery active" : "Discovery stopped"}
        ${state.discovery.error || ""}
      </p>
      ${state.candidates.map(
        (candidate) =>
          html`<div style=${row}>
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
    <section style=${box}>
      <h4>Peers and requests</h4>
      ${!state.peers.length && html`<p>No paired clients.</p>`}
      ${state.peers.map(
        (peer) =>
          html`<div style=${box}>
            <strong>${peer.alias}</strong> ${peer.name} · ${peer.status}
            <div style="overflow-wrap:anywhere">
              <code>${peer.clientId}</code>
            </div>
            <div style=${row}>
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
            html`<details>
              <summary>Incoming permissions</summary>
              <p>
                ${peer.scope} · ${peer.modes.join(", ")} · files
                ${peer.files ? "on" : "off"}
              </p>
              <button
                disabled=${busy}
                onClick=${() => {
                  const scope = prompt(
                    "Scope: none, inbox-only, named-agents, all-advertised",
                    peer.scope,
                  );
                  if (!scope) return;
                  const modes = prompt(
                    "Modes (comma-separated): queue, auto, steer",
                    peer.modes.join(","),
                  );
                  if (!modes) return;
                  const agents = prompt(
                    "Named aliases (comma-separated)",
                    peer.agents.join(","),
                  );
                  const files = window.confirm("Allow bounded file transfers?");
                  const confirmation =
                    prompt("Type ALLOW REMOTE ACCESS for wider permissions") ||
                    "";
                  run({
                    action: "policy",
                    peer: peer.id,
                    scope,
                    modes: modes.split(",").map((s) => s.trim()),
                    agents: (agents || "")
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    files,
                    confirmation,
                  });
                }}
              >
                Edit permissions
              </button>
            </details>`}
          </div>`,
      )}
    </section>
    <section style=${box}>
      <h4>Advertised agents</h4>
      ${state.advertised.map(
        (a) =>
          html`<div style=${row}>
            @${a.alias} → ${a.local_agent}<button
              onClick=${() => run({ action: "unadvertise", alias: a.alias })}
            >
              Hide
            </button>
          </div>`,
      )}
      <select
        style=${input}
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
    </section>
    <section style=${box}>
      <h4>Relays</h4>
      <select
        style=${input}
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
      <p>
        Custom list: HTTPS URL and optional authTokenKeychain reference. Never
        paste a secret here.
      </p>
      <textarea
        style=${input}
        rows="3"
        value=${relayText}
        onInput=${(e) => setRelayText(e.target.value)}
      /><button
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
    <section style=${box}>
      <h4>Delivery</h4>
      ${state.messages.map(
        (m) =>
          html`<div style=${row}>
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
    <section style=${box}>
      <h4>Mediated work</h4>
      <p>Remote requests never execute tools automatically.</p>
      ${state.work
        .filter(
          (w) =>
            w.direction === "inbound" &&
            ["pending", "response-pending"].includes(w.status),
        )
        .map(
          (w) =>
            html`<div style=${box}>
              <code>${w.id}</code>
              <pre style="white-space:pre-wrap">${w.data.prompt}</pre>
              <button
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
              </button>
            </div>`,
        )}
    </section>
    ${error && html`<p role="alert">${error}</p>`}
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
    component: RemotePeerSettings,
    order: 190,
  });
  registry?.notifySettingsPanesChanged?.();
}
