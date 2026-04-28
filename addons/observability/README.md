# piclaw-addon-observability

OpenTelemetry observability for piclaw — trace errors and agent turns across multiple instances to **Azure Application Insights** (with Live Metrics Stream) and **local Graphite**.

Uses the runtime's structured log-sink contract. The runtime never imports OTel — it just logs structured records. This addon subscribes to those records and creates OTel spans, exceptions, and Graphite metrics from them.

## Setup

### 1. Install

From the Add-Ons settings pane, or:

```bash
bun add @rcarmo/piclaw-addon-observability
```

### 2. Store the App Insights connection string in keychain

```bash
piclaw keychain set azure/appinsights-connection-string \
  --type secret \
  --secret "InstrumentationKey=...;IngestionEndpoint=..."
```

### 3. Configure via Settings → Observability

| Field | Type | Default | Description |
|---|---|---|---|
| **Enabled** | checkbox | off | Master switch |
| **Instance name** | text | `hostname()` | Identifies this instance in App Insights (`cloud_RoleInstance`). Set to e.g. `smith`, `relay`, `orangepi`. |
| **App Insights enabled** | checkbox | on | Sub-toggle for the Azure backend |
| **Connection string (keychain entry)** | text | — | Keychain entry name holding the connection string (not the secret itself) |
| **Live Metrics Stream** | checkbox | on | Real-time telemetry in the Azure portal ([QuickPulse](https://learn.microsoft.com/en-us/azure/azure-monitor/app/live-stream)) |
| **Standard metrics** | checkbox | on | OTel standard metrics collection (CPU, memory, request rate) |
| **Sampling ratio** | number | 1 | 0–1. 1 = send all traces. 0.5 = sample 50%. |
| **Graphite enabled** | checkbox | off | Sub-toggle for Carbon plaintext push |
| **Host** | text | — | Graphite/Carbon receiver host, e.g. `192.168.1.250` |
| **Port** | number | 2003 | Carbon plaintext port |
| **Metric prefix** | text | `piclaw` | Root prefix for all Graphite metric paths |

Config is stored in the extension KV store (SQLite, global scope). Secrets stay in keychain.

### 4. Deploy to other instances

Each piclaw instance needs:
- The addon installed
- The same keychain entry with the App Insights connection string
- `instance_name` set to a unique value in Settings → Observability

---

## Architecture

```
smith (LXC)         ──┐
relay (Docker)       ──┤
orangepi (host)      ──┼──► Azure Application Insights (OTLP/HTTP)
sandbox (Docker)     ──┤      ├─ Failures blade: all errors across fleet
microvm (systemd)    ──┘      ├─ Application Map: instance topology
                              ├─ Transaction Search: per-turn traces
                              └─ Live Metrics: real-time stream

192.168.1.250:2003   ◄── Carbon plaintext (any instance with Graphite enabled)
```

No OTel Collector required. Each instance exports directly via `@azure/monitor-opentelemetry`.

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
