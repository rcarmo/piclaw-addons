---
name: linkr-reboot-bios
description: Plan and perform a bounded BIOS, UEFI, boot-menu, or recovery entry attempt through the native linkr tool, using operator-assisted reboot anchors and evidence-based timing.
distribution: public
---

# Linkr reboot and BIOS entry

Use this skill when the user needs to reach BIOS setup, a one-time boot menu, or another firmware-adjacent destination on a machine attached to Linkr.

This is a high-risk workflow. Read [tool contract](../../docs/tool-contract.md), [safety rules](../../docs/safety-and-scope.md), and [qualification notes](../../docs/qualification-and-testing.md) first.

## Required facts before execution

Establish these facts explicitly:

- which configured profile is being used;
- the attached machine identity in `targetIdentity`;
- the desired destination: BIOS setup, one-time boot menu, recovery, or normal reboot;
- the evidence for the entry key, such as a visible on-screen prompt, vendor documentation, or operator confirmation;
- the reboot method that is actually available;
- whether updates, flashing, encryption setup, or filesystem repair are in progress.

If any destructive or high-risk background activity may be happening, stop. No update power cuts.

## Plan first

1. Use `status` and `snapshot` to identify the current state.
2. Call `reboot.plan` to preview the intended reboot path.
3. Call `firmware.entry.plan` with the exact `job` object you would later execute.
4. Restate the destination, chosen key, timing, and reboot anchor before execution.

Important: v0.1 does **not** promise automatic OS reboot integration. If there is no separately verified reboot path, the default anchor is operator-assisted.

## Execution model

When authorised, execute only a bounded local job:

- start with `job.start`;
- provide `device_id`;
- provide `job.kind: "firmware-entry"`;
- send the selected key only;
- use a finite `duration_ms`, `capture_interval_ms`, `tap_start_ms`, `tap_interval_ms`, and `tap_duration_ms`;
- require `execute:true`.

Example:

```json
{
  "action": "job.start",
  "device_id": "lab-workstation-a",
  "job": {
    "kind": "firmware-entry",
    "duration_ms": 15000,
    "capture_interval_ms": 1000,
    "key": "F2",
    "key_evidence": "Splash prompt says F2 for Setup.",
    "tap_start_ms": 500,
    "tap_interval_ms": 250,
    "tap_duration_ms": 4000
  },
  "execute": true
}
```

The job exists to avoid one-LLM-turn-per-tap timing errors. It is not permission to keep pressing forever.

## Detection model

Firmware detection is an **agent judgement from snapshots**, not a numeric heuristic that declares success automatically.

After the tap burst:

- stop further key taps;
- inspect subsequent snapshots for visible firmware or boot-menu evidence;
- if normal OS boot continues, report a missed window and tune one timing parameter at a time;
- if the screen is dark, separate no-signal, stale capture, display-mode switch, and machine-off hypotheses.

There is no built-in learned timing system yet.

## Reboot distinctions

Do not blur these cases together:

- ordinary OS reboot;
- forced reset or power cycle;
- Linkr appliance reboot;
- HID reinitialisation.

`Ctrl+Alt+Delete` is not a universal safe reboot fallback.

## Do not use unless verified

Until a real adapter is documented and qualified, treat these as unavailable for this workflow:

- `power.press`
- `power.reset`
- `power.cycle`
- `device.reboot`

Return `unsupported` rather than guessing.

## Cancellation and recovery

`job.cancel` may return `cancellation_requested:true` before the job has fully settled. If an in-flight input may have been interrupted, observe first and use `input.release` only when justified.

## Evidence to keep

Record in your narrative:

- chosen profile and `targetIdentity`;
- destination and entry-key evidence;
- the exact planned timing window;
- whether execution used an operator-assisted reboot anchor;
- the first post-reboot visual evidence and the final observed outcome.
