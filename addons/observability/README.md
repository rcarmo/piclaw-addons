# piclaw-addon-observability

OpenTelemetry observability for piclaw — trace errors and agent turns across multiple instances to **Azure Application Insights** (with Live Metrics Stream) and **local Graphite**.

Uses the runtime's structured log-sink contract. The runtime never imports OTel — it just logs structured records. This addon subscribes to those records and creates OTel spans, exceptions, and Graphite metrics from them.

## Setup

### 1. Install

Open **Settings → Add-Ons** and install **observability** from the catalog.

### 2. Configure via Settings → Observability

The connection string can be pasted directly into the settings pane — it is saved to the keychain automatically as `azure/appinsights-connection-string`. A restart is needed after setting or changing the connection string.

| Field | Type | Default | Description |
|---|---|---|---|
| **Enabled** | checkbox | off | Master switch |
| **Instance name** | text | `hostname()` | Identifies this instance in App Insights (`cloud_RoleInstance`). Set to e.g. `smith`, `relay`, `orangepi`. |
| **App Insights enabled** | checkbox | on | Sub-toggle for the Azure backend |
| **Connection string** | password | — | Paste the App Insights connection string directly. Saved to keychain as `azure/appinsights-connection-string`. |
| **Live Metrics Stream** | checkbox | on | Real-time telemetry in the Azure portal ([QuickPulse](https://learn.microsoft.com/en-us/azure/azure-monitor/app/live-stream)) |
| **Standard metrics** | checkbox | on | OTel standard metrics collection (CPU, memory, request rate) |
| **Sampling ratio** | number | 1 | 0–1. 1 = send all traces. 0.5 = sample 50%. |
| **Graphite enabled** | checkbox | off | Sub-toggle for Carbon plaintext push |
| **Host** | text | — | Graphite/Carbon receiver host, e.g. `192.168.1.250` |
| **Port** | number | 2003 | Carbon plaintext port |
| **Metric prefix** | text | `piclaw` | Root prefix for all Graphite metric paths |

## Storage model

| What | Where |
|---|---|
| App Insights connection string | **Keychain** — entry `azure/appinsights-connection-string`. Entered directly in the settings pane. |
| All other settings | **Runtime database** — extension KV store (SQLite, global scope, extension ID `observability`) |

No config files are written to disk.

### 3. Deploy to other instances

Each piclaw instance needs:
- The addon installed
- The same keychain entry with the App Insights connection string
- `instance_name` set to a unique value in Settings → Observability

---

## Architecture

<svg viewBox="0 0 680 260" xmlns="http://www.w3.org/2000/svg" style="max-width:680px;width:100%;height:auto;font-family:system-ui,sans-serif;font-size:13px">
  <defs>
    <marker id="ah" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6" fill="#2563eb"/></marker>
  </defs>
  <!-- Instances -->
  <rect x="10" y="10" width="140" height="150" rx="8" fill="#f0f4ff" stroke="#2563eb" stroke-width="1.5"/>
  <text x="80" y="32" text-anchor="middle" font-weight="700" fill="#0f1c2e">Instances</text>
  <text x="80" y="54" text-anchor="middle" fill="#555" font-size="12">smith (LXC)</text>
  <text x="80" y="72" text-anchor="middle" fill="#555" font-size="12">relay (Docker)</text>
  <text x="80" y="90" text-anchor="middle" fill="#555" font-size="12">orangepi (host)</text>
  <text x="80" y="108" text-anchor="middle" fill="#555" font-size="12">sandbox (Docker)</text>
  <text x="80" y="126" text-anchor="middle" fill="#555" font-size="12">microvm (systemd)</text>
  <!-- App Insights -->
  <rect x="280" y="10" width="260" height="150" rx="8" fill="#eff6ff" stroke="#2563eb" stroke-width="1.5"/>
  <text x="410" y="32" text-anchor="middle" font-weight="700" fill="#1e3a5f">Azure Application Insights</text>
  <text x="410" y="56" text-anchor="middle" fill="#555" font-size="11">Failures blade — errors by instance</text>
  <text x="410" y="74" text-anchor="middle" fill="#555" font-size="11">Application Map — topology</text>
  <text x="410" y="92" text-anchor="middle" fill="#555" font-size="11">Transaction Search — per-turn traces</text>
  <text x="410" y="110" text-anchor="middle" fill="#555" font-size="11">Live Metrics — real-time stream</text>
  <!-- Arrow instances → App Insights -->
  <line x1="150" y1="85" x2="275" y2="85" stroke="#2563eb" stroke-width="2" marker-end="url(#ah)"/>
  <text x="212" y="78" text-anchor="middle" fill="#2563eb" font-size="10" font-weight="600">OTLP/HTTP</text>
  <!-- Graphite -->
  <rect x="280" y="190" width="200" height="50" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="380" y="220" text-anchor="middle" font-weight="600" fill="#166534">Graphite :2003</text>
  <!-- Arrow instances → Graphite -->
  <line x1="120" y1="160" x2="275" y2="215" stroke="#16a34a" stroke-width="1.5" stroke-dasharray="6 3" marker-end="url(#ah)"/>
  <text x="180" y="200" text-anchor="middle" fill="#16a34a" font-size="10" font-weight="600">Carbon plaintext</text>
</svg>

---

## How it works

The addon uses piclaw's **log-sink contract** — a generic API that any addon can use:

```
runtime                              addon
───────                              ─────
log.info("Prompting session", {
  operation: "run_agent.prompt",     ──►  sink receives record
  chatJid: "web:default",                 creates Span "agent.turn"
  model: "azure-openai/gpt-5-4",         stores in inflightTurns map
})

  ... model runs, tools fire ...

log.info("Tool execution ended", {
  operation: "tool.call.end",        ──►  sink receives record
  chatJid: "web:default",                 creates child Span "tool.call"
  toolName: "bash",                       pushes Graphite metric
  durationMs: 320,
})

log.info("Agent run completed", {
  operation: "run_agent.complete",   ──►  sink receives record
  chatJid: "web:default",                 finds inflight span
  durationMs: 4523,                       ends span → App Insights
})                                        pushes Graphite metrics
```

If the addon isn't installed, no sink is registered and there is zero overhead.

See the [runtime observability docs](https://github.com/rcarmo/piclaw/blob/main/docs/observability.md) for the full log-sink API and operation reference.

---

## Instance identity

| OTel Resource attribute | App Insights field | Value |
|---|---|---|
| `service.name` | `cloud_RoleName` | `piclaw` |
| `service.instance.id` | `cloud_RoleInstance` | config `instance_name` (or hostname) |
| `host.name` | — | always OS `hostname()` |
| `deployment.environment` | custom dimension | auto-detected: `docker` / `lxc` / `host-native` |
| `service.version` | — | piclaw package version |

---

## Data sent

### Log operation → Span / Metric mapping

| Log operation | OTel Span | Graphite metric |
|---|---|---|
| `run_agent.prompt` → `run_agent.complete` | `agent.turn` (paired by chatJid) | `agent.turn.count`, `agent.turn.duration_ms`, `agent.turn.success` |
| `run_agent.prompt` → `run_agent` (error) | `agent.turn` (ERROR + exception) | `agent.turn.count`, `agent.turn.error` |
| `run_agent.no_terminal_reply` | `agent.turn` (ERROR) | `agent.turn.error` |
| `run_agent.attempt_failed` | `provider.error` (exception) | `recovery.attempts`, `provider.error.<classifier>` |
| `tool.call.end` | `tool.call` (child of `agent.turn`) | `tool.<name>.count`, `tool.<name>.duration_ms` |
| `dream.complete` | `dream` | `dream.duration_ms` |
| `get_or_create.create_main_session` | — | `session.created` |
| `evict_idle.*` | — | `session.evicted` |
| Any warn/error with `operation` | `log.warn` / `log.error` | — |

### Span schemas

#### agent.turn (successful)

```json
{
  "name": "agent.turn",
  "kind": "INTERNAL",
  "status": { "code": "OK" },
  "duration": "4523ms",
  "attributes": {
    "piclaw.chat_jid": "web:default:branch:0f3858079ad7",
    "piclaw.instance": "smith",
    "piclaw.model": "azure-openai/gpt-5-4",
    "piclaw.turn.status": "success",
    "piclaw.turn.duration_ms": 4523,
    "piclaw.turn.output_chars": 1280
  }
}
```

#### agent.turn (error)

```json
{
  "name": "agent.turn",
  "status": { "code": "ERROR", "message": "Prompt completed without emitting an assistant reply..." },
  "duration": "8912ms",
  "attributes": {
    "piclaw.chat_jid": "web:default:branch:0f3858079ad7",
    "piclaw.instance": "smith",
    "piclaw.model": "azure-openai/gpt-5-4",
    "piclaw.turn.status": "error",
    "piclaw.recovery.attempts": 0
  },
  "events": [
    {
      "name": "exception",
      "attributes": {
        "exception.type": "Error",
        "exception.message": "Prompt completed without emitting an assistant reply before finalization..."
      }
    }
  ]
}
```

#### tool.call

```json
{
  "name": "tool.call",
  "status": { "code": "OK" },
  "duration": "320ms",
  "attributes": {
    "piclaw.chat_jid": "web:default",
    "piclaw.instance": "smith",
    "piclaw.tool.name": "bash",
    "piclaw.tool.duration_ms": 320
  }
}
```

#### provider.error

```json
{
  "name": "provider.error",
  "status": { "code": "ERROR", "message": "429 Too Many Requests" },
  "attributes": {
    "piclaw.chat_jid": "web:default",
    "piclaw.instance": "relay",
    "piclaw.error.classifier": "rate_limit"
  },
  "events": [
    { "name": "exception", "attributes": { "exception.message": "429 Too Many Requests" } }
  ]
}
```

### Graphite metric paths

```
# Agent turns
piclaw.smith.agent.turn.count 1 1745828400
piclaw.smith.agent.turn.duration_ms 4523 1745828400
piclaw.smith.agent.turn.success 1 1745828400
piclaw.smith.agent.turn.error 0 1745828400

# Tool calls
piclaw.smith.tool.bash.count 1 1745828400
piclaw.smith.tool.bash.duration_ms 320 1745828400
piclaw.smith.tool.bash.error 0 1745828400

# Recovery
piclaw.smith.recovery.attempts 2 1745828400
piclaw.smith.provider.error.rate_limit 1 1745828400

# Session lifecycle
piclaw.smith.session.created 1 1745828400
piclaw.smith.session.evicted 0 1745828400

# Dream
piclaw.smith.dream.duration_ms 45000 1745828400
```

Queryable as:

```
piclaw.*.agent.turn.error          # errors across all instances
piclaw.smith.tool.*.duration_ms    # all tool durations on smith
piclaw.relay.provider.error.*      # all provider errors on relay
```

### Azure Application Insights views

| Feature | What it shows |
|---|---|
| **Application Map** | All piclaw instances with health and dependency links |
| **Failures blade** | Errors grouped by `cloud_RoleInstance`: smith 2, relay 5, orangepi 1 |
| **Transaction Search** | Individual turn traces with tool-call child spans |
| **Live Metrics Stream** | Real-time exceptions, request rate, CPU/memory per instance |

---

## Dependencies

- `@azure/monitor-opentelemetry` ^1.16 — official Azure Monitor OTel distro (includes Live Metrics)
- `@opentelemetry/api` ^1.9 — OTel trace + context API
