# Linkr

Public documentation and bundled skills for the implemented Piclaw add-on that controls a Radxa Linkr KVM through one native `linkr` tool.

Status: **v0.1 implemented**.

What is implemented in this directory today:

- the native `linkr` tool and Settings UI;
- configured profiles with explicit `device_id` selection;
- fresh snapshots;
- preview-first HID actions gated by `execute:true`;
- bounded local jobs for `capture` and `firmware-entry`;
- private per-job evidence on disk;
- seven bundled skills.

What is **not** verified or not implemented yet:

- live add-on verification against a real Linkr from this packaged add-on;
- browser/UI end-to-end coverage for the add-on;
- `screen.compare` or other semantic compare primitives;
- learned per-device timing or durable job resume after restart;
- virtual media, ATX/power, or Linkr appliance reboot support.

Testing status so far: **15 isolated Linkr tests passed (76 assertions)**. A separate loopback-only Playwright Settings fixture passed: rendering, profile editing, confirmation, save, disabled-HID default and no device traffic. These are not packaged live-hardware or full host end-to-end tests.

## Install contract

This add-on is intended to install through Piclaw's public add-on catalog using a zero-auth public tarball URL.

Current generated catalog entry shape:

- catalog source: [`catalog.json`](../../catalog.json)
- add-on package name: `@rcarmo/piclaw-addon-linkr`
- current catalog install URL: `https://rcarmo.github.io/piclaw-addons/packages/piclaw-addon-linkr-0.1.0.tgz`

This matches the repository's generated first-party tarball convention.

## What this add-on is for

Use Linkr when Piclaw needs screenshot-based control of a specific machine reachable through a Radxa Linkr KVM and safer direct methods such as SSH, guest agents, browser automation, or platform-native control are unavailable.

The operating model has three layers:

1. **Tool primitives** — snapshots, HID actions, bounded local jobs, and evidence.
2. **Unsupported-but-named families** — `power.*`, `media.*`, and `device.reboot` return `unsupported` until a verified adapter exists.
3. **Skills** — BIOS entry, firmware navigation, boot selection, OS install, recovery, and qualification logic that interpret the observed screen and decide when to stop.

## Current scope

| Area | Implemented in v0.1 | Limitations / notes |
|---|---|---|
| Profiles | Settings-backed profiles with `id`, `label`, `origin`, `tokenKeychain`, `targetIdentity`, `inputEnabled` | `origin` must be unique HTTP(S) origin with no credentials, path, query, or hash |
| Snapshot | `status` reachability check and `snapshot` JPEG capture | Fresh HTTP capture only; source-frame freshness beyond that is unverified |
| HID input | `key.tap`, `key.combo`, `key.repeat`, `text`, `mouse.move`, `mouse.click`, `mouse.drag`, `mouse.scroll`, `input.batch`, `input.release` | Preview by default; `execute:true` required to send |
| Jobs | `capture` and `firmware-entry` via `job.start`, `job.status`, `job.cancel` | Jobs are local, bounded, and do not resume after restart |
| Evidence | Per-job `job.json` plus `frame-*.jpg` artifacts | Job directories are pruned only when the next job starts |
| Power/media/device management | Public action names present | Currently always `unsupported`; no request sent |
| Skills | Seven bundled skills | Guidance only until live-qualified per device |

## Tool contract summary

Implemented action names:

- `help`
- `capabilities`
- `profile.list`
- `profile.select`
- `status`
- `snapshot`
- `key.tap`
- `key.combo`
- `key.repeat`
- `text`
- `mouse.move`
- `mouse.click`
- `mouse.drag`
- `mouse.scroll`
- `input.batch`
- `input.release`
- `job.start`
- `job.status`
- `job.cancel`
- `reboot.plan`
- `firmware.entry.plan`
- `power.status`
- `power.press`
- `power.reset`
- `power.cycle`
- `media.list`
- `media.mount`
- `media.eject`
- `device.reboot`

See [docs/tool-contract.md](./docs/tool-contract.md) for exact payloads and [docs/safety-and-scope.md](./docs/safety-and-scope.md) for operating rules.

## Profiles and Settings

Profiles are configured in the add-on Settings pane, not inline per call.

Required profile fields:

- `id`
- `label`
- `origin`
- `tokenKeychain`
- `targetIdentity`
- `inputEnabled`

Important rules from the implementation:

- calls resolve an explicit `device_id` or a previously selected session profile;
- `profile.select` stores selection per chat/session;
- `tokenKeychain` is a keychain entry name, not the secret itself;
- `targetIdentity` refers to the attached machine, not just the Linkr appliance;
- moving cables or swapping the attached machine invalidates prior timing and qualification assumptions.

## Exact calling shape to prefer

Use `device_id`, not older `profile` fields in examples.

Read-only examples:

```json
{"action":"status","device_id":"lab-workstation-a"}
```

```json
{"action":"snapshot","device_id":"lab-workstation-a"}
```

Preview and execute examples:

```json
{"action":"key.tap","device_id":"lab-workstation-a","key":"F2"}
```

```json
{"action":"key.tap","device_id":"lab-workstation-a","key":"F2","execute":true}
```

```json
{"action":"key.combo","device_id":"lab-workstation-a","keys":["ControlLeft","AltLeft","Delete"],"execute":true}
```

```json
{"action":"text","device_id":"lab-workstation-a","text":"root\n","execute":true}
```

```json
{"action":"mouse.move","device_id":"lab-workstation-a","x":0.5,"y":0.5,"execute":true}
```

```json
{"action":"mouse.click","device_id":"lab-workstation-a","x":0.5,"y":0.5,"execute":true}
```

```json
{"action":"mouse.drag","device_id":"lab-workstation-a","x":0.2,"y":0.2,"to_x":0.8,"to_y":0.8,"execute":true}
```

```json
{"action":"mouse.scroll","device_id":"lab-workstation-a","wheel_y":-3,"wheel_x":0,"execute":true}
```

```json
{"action":"key.repeat","device_id":"lab-workstation-a","key":"F12","count":5,"interval_ms":250,"execute":true}
```

`input.batch` takes raw `events`:

```json
{
  "action": "input.batch",
  "device_id": "lab-workstation-a",
  "events": [
    ["keyboard", "ControlLeft", true],
    ["keyboard", "KeyL", true],
    ["delay", 80],
    ["keyboard", "KeyL", false],
    ["keyboard", "ControlLeft", false]
  ],
  "execute": true
}
```

Job examples:

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

```json
{
  "action": "job.start",
  "device_id": "lab-workstation-a",
  "job": {
    "kind": "firmware-entry",
    "duration_ms": 15000,
    "capture_interval_ms": 1000,
    "key": "F2",
    "key_evidence": "Vendor splash says F2 for Setup.",
    "tap_start_ms": 500,
    "tap_interval_ms": 250,
    "tap_duration_ms": 4000
  },
  "execute": true
}
```

```json
{"action":"job.status","job_id":"<job-id>"}
```

```json
{"action":"job.status","job_id":"<job-id>","frame_index":0}
```

```json
{"action":"job.cancel","job_id":"<job-id>"}
```

## Safety and runtime limitations

- Snapshot-only actions are read-only.
- HID mutations default to preview and require `execute:true`.
- `firmware.entry.plan` is planning-only; it does not execute a reboot or a job.
- Jobs are limited to **1–60 seconds**.
- `capture_interval_ms` must be **1000–10000 ms**.
- `tap_duration_ms` is limited to **200–5000 ms**.
- `key.repeat` is limited to **1–20 repeats**, **200–1000 ms** intervals, and **<=5000 ms** total repeat window.
- Job evidence is capped at **32 MiB per job**.
- Artifact pruning keeps roughly the newest **20** job directories and at most **24 hours** of history, and only runs when a new job starts.
- Leases are **in-process global state only**. They prevent conflicting control inside one running process, but they are not a multi-process or distributed lock guarantee.
- `job.cancel` can immediately return `cancellation_requested:true` while the job still shows `running`; poll `job.status` until the state changes.
- If input delivery becomes uncertain, use observation first. `input.release` only releases tracked key/button state and cannot undo already applied actions.
- Power, media, `device.reboot`, durable resume, and true `screen.compare` are not available in v0.1.

## Privacy and evidence

Only job artifacts are automatically private by file mode:

- job directories: mode `0700`
- `job.json` and saved frames: mode `0600`

That is **not** a blanket privacy guarantee for every other integration surface. It is just the implemented on-disk protection for job evidence.

## Bundled skills

- `linkr-control` — safe screenshot/HID usage for ordinary interactive control
- `linkr-reboot-bios` — plan and execute bounded firmware-entry attempts
- `linkr-firmware-navigation` — navigate BIOS/UEFI menus one observed step at a time
- `linkr-boot-selection` — perform one-time boot override or explicit persistent boot-order change
- `linkr-os-install` — operator-supervised installation with explicit disk approval and credential handoff
- `linkr-recovery` — least-disruptive troubleshooting and recovery
- `linkr-qualify-device` — read-only inventory plus reversible qualification tests and evidence collection

## Source references

These docs are derived from the implemented source, not a speculative contract:

- `extension.ts` — tool actions, parameters, dispatch rules, previews, unsupported families, and result semantics
- `jobs.ts` — job schema, limits, summaries, retention, evidence handling, leases, and cancellation behaviour
- `config.ts` — profile schema and selection rules
- `client.ts` — HTTP endpoints, auth header use, timeout/size limits, JPEG validation, and release behaviour
- `input.ts` — raw event validation and batch limits

## Verification status

Honest current status:

- implemented native add-on surface: yes
- isolated Linkr tests: yes, 15 passing (76 assertions)
- live packaged add-on verification against real hardware: not yet
- browser/UI test coverage for the add-on: not yet
- power/media/device-management verification: none
- BIOS/boot/install flows: tooling implemented, but still require per-device live qualification before trust

## License and attribution

This directory uses the MIT license. It preserves attribution for upstream Radxa Linkr material reviewed during development. Radxa and Linkr are names of their respective owners; this add-on is an independent Piclaw integration. See [LICENSE](./LICENSE).

### Settings fixture

![Linkr Settings in an isolated mocked browser fixture](docs/settings-fixture.png)

This screenshot uses disposable example identities and a mocked config API. It is **not** a microVM or live-device capture. No device requests were sent. To reproduce, provide an installed Playwright entrypoint, host Preact/HTM modules and the matching browser installation:

```sh
LINKR_FIXTURE_PLAYWRIGHT=/path/to/playwright/index.mjs \
LINKR_FIXTURE_HOST_MODULES=/path/to/host/node_modules \
PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers \
bun addons/linkr/scripts/settings-fixture.ts
```

Re-run after changing the Settings surface. A full disposable Piclaw integration test remains a release qualification gate.
