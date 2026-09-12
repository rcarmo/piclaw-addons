---
name: linkr-qualify-device
description: Qualify a Linkr profile and attached machine for safe future automation using read-only inventory first, reversible HID checks, and evidence tied to the exact target identity.
distribution: public
---

# Linkr qualify device

Use this skill before trusting a new Linkr profile for BIOS work, installation, or recovery.

Qualification is how you learn what is real for one machine without pretending the result is portable to every machine.

## Required profile baseline

The profile should be configured in Settings with at least:

- `id`
- `label`
- `origin`
- `tokenKeychain`
- `targetIdentity`
- `inputEnabled`

If `targetIdentity` is vague or clearly stale, update the operational record before relying on the profile.

## Read-only first

Start with:

- `profile.list`
- `profile.select`
- `status`
- `capabilities`
- `snapshot`

Confirm the visible attached machine matches the intended profile. Qualification belongs to the machine actually on the cable, not just the Linkr appliance.

## What to qualify

Qualify, with evidence:

- screenshot freshness and resolution;
- practical cadence for repeated snapshots;
- keyboard layout assumptions;
- simple reversible HID effects;
- whether a documented firmware-entry key seems valid for this machine;
- whether unsupported families remain unsupported in practice.

## Reversible HID checks

Only with operator consent:

- preview a tiny action first;
- resend with `execute:true`;
- verify with a new `snapshot`.

Good examples are moving focus one step in a visible menu or opening a harmless boot prompt. Do not begin with destructive actions.

## Firmware timing qualification

Qualify firmware-entry timing only during a maintenance window. Use:

- `reboot.plan`
- `firmware.entry.plan`
- `job.start` with a `job` payload like:

```json
{
  "action": "job.start",
  "device_id": "lab-workstation-a",
  "job": {
    "kind": "firmware-entry",
    "duration_ms": 15000,
    "capture_interval_ms": 1000,
    "key": "F2",
    "key_evidence": "Vendor splash prompt and operator both say F2.",
    "tap_start_ms": 500,
    "tap_interval_ms": 250,
    "tap_duration_ms": 4000
  },
  "execute": true
}
```

Tie the resulting notes to the exact `targetIdentity`, visible firmware version when known, and date. A recipe learned on one firmware revision or one cable path may not survive hardware changes.

## Unsupported means unsupported

Until a real adapter is documented and qualified, expect these actions to return `unsupported`:

- `power.status`
- `power.press`
- `power.reset`
- `power.cycle`
- `media.list`
- `media.mount`
- `media.eject`
- `device.reboot`

Do not send speculative mutation probes just to discover whether they might work.

## Shareable outputs

When writing up qualification results, keep them sanitised:

- no tokens;
- no private hostnames or operator-specific network details;
- no reusable credentials;
- no screenshots unless needed for the evidence record.

The goal is a portable operational recipe, not leakage of the local environment.
