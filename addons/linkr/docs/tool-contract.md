# Linkr tool contract

Status: implemented v0.1 contract for the native Piclaw `linkr` tool in this add-on.

This document reflects the current code in `extension.ts`, `jobs.ts`, `config.ts`, `client.ts`, and `input.ts`.

## Action list

| Family | Action | Current behaviour |
|---|---|---|
| Discovery | `help` | Returns action list, calling pattern, limits, and capability summary |
| Discovery | `capabilities` | Returns current implementation capability summary |
| Profile | `profile.list` | Returns stored config shape from Settings |
| Profile | `profile.select` | Stores the selected `device_id` for the current chat |
| Observe | `status` | Verifies snapshot reachability and reports target, lease state, and HID policy |
| Observe | `snapshot` | Returns a fresh JPEG screenshot plus metadata |
| Input | `key.tap` | Full down/up tap for `key` |
| Input | `key.combo` | Chord for `keys` with reverse-order release |
| Input | `key.repeat` | Finite repeated taps of one `key` |
| Input | `text` | ASCII text entry with chunking and delays |
| Input | `mouse.move` | Absolute pointer move to `x`,`y` |
| Input | `mouse.click` | Bounded click at `x`,`y` |
| Input | `mouse.drag` | Bounded drag from `x`,`y` to `to_x`,`to_y` |
| Input | `mouse.scroll` | Wheel move using `wheel_y`,`wheel_x` |
| Input | `input.batch` | Validated raw `events` array |
| Safety | `input.release` | Releases tracked key/button state for uncertain delivery owned by the same chat |
| Jobs | `job.start` | Starts a bounded local `capture` or `firmware-entry` job |
| Jobs | `job.status` | Returns summary; returns a frame image only when `frame_index` is explicitly provided |
| Jobs | `job.cancel` | Requests cancellation and returns `cancellation_requested:true` |
| Planning | `reboot.plan` | Returns supported reboot-planning guidance only |
| Planning | `firmware.entry.plan` | Planning-only dry run for a bounded firmware-entry job |
| Optional power | `power.status` | Returns `unsupported` today |
| Optional power | `power.press` | Returns `unsupported` today |
| Optional power | `power.reset` | Returns `unsupported` today |
| Optional power | `power.cycle` | Returns `unsupported` today |
| Optional media | `media.list` | Returns `unsupported` today |
| Optional media | `media.mount` | Returns `unsupported` today |
| Optional media | `media.eject` | Returns `unsupported` today |
| Optional appliance | `device.reboot` | Returns `unsupported` today |

## Top-level parameters

Current top-level tool parameters are:

- `action`
- `device_id`
- `execute`
- `key`
- `keys`
- `text`
- `x`
- `y`
- `to_x`
- `to_y`
- `wheel_y`
- `wheel_x`
- `count`
- `interval_ms`
- `events`
- `job_id`
- `frame_index`
- `job`

Do **not** use older doc-only names such as `profile`, `jobType`, `plan`, `entryKey`, `tapStartMs`, `deadlineMs`, or `rebootMethod` in examples for this add-on.

## Profile model

Profiles are configured in Settings and validated as:

```json
{
  "profiles": [
    {
      "id": "lab-workstation-a",
      "label": "Lab workstation A",
      "origin": "https://linkr-a.example.net",
      "tokenKeychain": "linkr/lab-workstation-a",
      "targetIdentity": "Dell OptiPlex 7090 / UEFI 1.18.0",
      "inputEnabled": false
    }
  ]
}
```

Rules from `config.ts`:

- at most 32 profiles;
- `id` must be unique and match `^[a-z0-9][a-z0-9-]{0,47}$`;
- `origin` must be a unique HTTP(S) origin with no credentials, path, query, or hash;
- `label`, `tokenKeychain`, and `targetIdentity` must be non-empty strings up to 200 chars;
- `inputEnabled` must be boolean.

## Observe actions

Example status call:

```json
{"action":"status","device_id":"lab-workstation-a"}
```

Typical status result fields:

- `device_id`
- `target_identity`
- `snapshot_reachable`
- `power_state` (`"unknown"` today)
- `input_enabled`
- `control_busy`
- `captured_at`

Example snapshot call:

```json
{"action":"snapshot","device_id":"lab-workstation-a"}
```

`snapshot` returns image content plus metadata including:

- `device_id`
- `target_identity`
- `captured_at`
- `freshness`

Current implementation returns base64 image content in the tool payload together with metadata.

## Preview and `execute:true`

Mutating actions preview by default. They send live input only when `execute:true` is set.

This applies to:

- `key.tap`
- `key.combo`
- `key.repeat`
- `text`
- `mouse.move`
- `mouse.click`
- `mouse.drag`
- `mouse.scroll`
- `input.batch`
- `job.start`

`firmware.entry.plan` is always planning-only even if `execute:true` is supplied.

## Input action examples

```json
{"action":"key.tap","device_id":"lab-workstation-a","key":"F2","execute":true}
```

```json
{"action":"key.combo","device_id":"lab-workstation-a","keys":["ControlLeft","AltLeft","Delete"],"execute":true}
```

```json
{"action":"key.repeat","device_id":"lab-workstation-a","key":"F12","count":4,"interval_ms":250,"execute":true}
```

```json
{"action":"text","device_id":"lab-workstation-a","text":"admin\n","execute":true}
```

```json
{"action":"mouse.move","device_id":"lab-workstation-a","x":0.5,"y":0.5,"execute":true}
```

```json
{"action":"mouse.click","device_id":"lab-workstation-a","x":0.5,"y":0.5,"execute":true}
```

```json
{"action":"mouse.drag","device_id":"lab-workstation-a","x":0.1,"y":0.2,"to_x":0.8,"to_y":0.9,"execute":true}
```

```json
{"action":"mouse.scroll","device_id":"lab-workstation-a","wheel_y":-2,"wheel_x":0,"execute":true}
```

`input.batch` raw-event example:

```json
{
  "action": "input.batch",
  "device_id": "lab-workstation-a",
  "events": [
    ["mouse_abs", 0, 0.25, 0.40, 0, 0],
    ["mouse_abs", 1, 0.25, 0.40, 0, 0],
    ["delay", 80],
    ["mouse_abs", 0, 0.25, 0.40, 0, 0]
  ],
  "execute": true
}
```

Raw event notes from `input.ts`:

- event count: 1–256;
- `keyboard`: `["keyboard", key, boolean]`;
- `mouse_abs` / `mouse_rel`: `[kind, buttons, x, y, wheel_y, wheel_x]`;
- `text`: `["text", chunk]` where each chunk is 1–30 ASCII chars and must be followed by a `delay` of at least 1000 ms;
- `delay`: `["delay", integer_ms]`;
- batches must release all pressed keys and mouse buttons;
- total delay across a batch must be <= 60000 ms;
- total text must be <= 1024 ASCII chars.

## Job schema

`job` currently supports exactly this shape:

```json
{
  "kind": "capture",
  "duration_ms": 10000,
  "capture_interval_ms": 1000
}
```

```json
{
  "kind": "firmware-entry",
  "duration_ms": 15000,
  "capture_interval_ms": 1000,
  "key": "F2",
  "key_evidence": "Vendor splash says F2 for Setup.",
  "tap_start_ms": 500,
  "tap_interval_ms": 250,
  "tap_duration_ms": 4000
}
```

Validation rules from `jobs.ts`:

- `kind` must be `capture` or `firmware-entry`;
- `duration_ms`: 1000–60000;
- `capture_interval_ms`: 1000–10000;
- firmware jobs additionally require:
  - `key` matching `^[A-Za-z][A-Za-z0-9]{0,39}$`
  - non-empty `key_evidence` up to 500 chars
  - `tap_start_ms`: 0–10000
  - `tap_interval_ms`: 200–2000
  - `tap_duration_ms`: 200–5000
  - `tap_start_ms + tap_duration_ms <= duration_ms`

## Job examples

Start a capture job:

```json
{
  "action": "job.start",
  "device_id": "lab-workstation-a",
  "job": {
    "kind": "capture",
    "duration_ms": 10000,
    "capture_interval_ms": 1000
  },
  "execute": true
}
```

Plan a firmware-entry job without sending anything:

```json
{
  "action": "firmware.entry.plan",
  "device_id": "lab-workstation-a",
  "job": {
    "kind": "firmware-entry",
    "duration_ms": 15000,
    "capture_interval_ms": 1000,
    "key": "F2",
    "key_evidence": "Operator confirmed F2 for setup.",
    "tap_start_ms": 500,
    "tap_interval_ms": 250,
    "tap_duration_ms": 4000
  }
}
```

Execute that job:

```json
{
  "action": "job.start",
  "device_id": "lab-workstation-a",
  "job": {
    "kind": "firmware-entry",
    "duration_ms": 15000,
    "capture_interval_ms": 1000,
    "key": "F2",
    "key_evidence": "Operator confirmed F2 for setup.",
    "tap_start_ms": 500,
    "tap_interval_ms": 250,
    "tap_duration_ms": 4000
  },
  "execute": true
}
```

Check status or retrieve a frame:

```json
{"action":"job.status","job_id":"<job-id>"}
```

```json
{"action":"job.status","job_id":"<job-id>","frame_index":0}
```

Request cancellation:

```json
{"action":"job.cancel","job_id":"<job-id>"}
```

Typical job summary fields from `jobs.ts`:

- `job_id`
- `device_id`
- `target_identity`
- `kind`
- `state`
- `started_at`
- `ended_at`
- `taps`
- `frames`
- `last_frame`
- `error`
- `artifact_directory`

## Cancellation, leases, and uncertainty

Current behaviour:

- `job.cancel` aborts future work and returns `cancellation_requested:true` immediately;
- an in-flight input may already be on the wire;
- `job.status` may still show `running` briefly after cancel is requested;
- uncertain delivery can leave tracked key/button state marked uncertain;
- `input.release` is the explicit follow-up for uncertain owned state.

Leases are keyed by device origin and held in in-process global state. This prevents conflicting control inside one process, but is **not** a distributed concurrency guarantee.

## Storage, retention, and privacy

Implemented behaviour:

- job directories are created under `.piclaw/data/addons/linkr/jobs/<job_id>`;
- directories use mode `0700`;
- `job.json` and saved frames use mode `0600`;
- evidence is capped at 32 MiB per job;
- pruning keeps the newest 20 directories and removes directories older than 24h on the next job start, excluding running jobs.

Recordings are therefore auto-private for job artifacts by file mode. This is not a blanket privacy opt-in for the whole add-on.

## Transport details

From `client.ts`:

- snapshot endpoint: `GET /api/public/snapshot`
- control endpoint: `POST /api/public/control`
- auth header: `Authorization: token <secret>`
- combined timeout: 75 seconds
- snapshot response limit: 10 MiB
- control/release response limit: 64 KiB
- snapshot must begin with the JPEG magic bytes
- control/release success requires JSON with `code === 0`

## Explicit limitations

Not currently implemented as working features:

- true `screen.compare`
- learned timing
- durable resume after process restart
- virtual media
- power control
- Linkr appliance reboot

These families should be documented as unavailable, not implied.
