# Qualification and testing

This add-on needs per-device qualification before anyone should trust it with BIOS, boot, or installer work.

## Qualification goals

A qualified profile should establish, with evidence:

- the Linkr unit actually reached by the configured `origin`;
- the attached machine identity in `targetIdentity`;
- screenshot freshness and practical cadence;
- reversible HID behaviour for the selected keyboard layout;
- whether firmware entry works for a documented key on that exact machine;
- whether unsupported families remain unsupported in practice.

## Qualification sequence

1. Configure the profile in Settings with:
   - `id`
   - `label`
   - `origin`
   - `tokenKeychain`
   - `targetIdentity`
   - `inputEnabled`
2. Run `profile.list`, `profile.select`, `status`, `capabilities`, and `snapshot` in read-only mode.
3. Verify the visible machine matches `targetIdentity`.
4. With the operator present, run tiny reversible HID checks using `execute:true`.
5. If delivery becomes uncertain, observe first and use `input.release` only when justified.
6. Qualify firmware-entry timing only inside an approved maintenance window.
7. Store notes tying the evidence to the exact machine, firmware revision when visible, and date.

## Firmware-entry qualification

Qualification for BIOS or boot-menu entry should use:

- a known destination such as BIOS setup or one-time boot menu;
- an operator-confirmed or vendor-documented key;
- `reboot.plan` followed by `firmware.entry.plan`;
- `job.start` with a real `job` payload, for example:

```json
{
  "action": "job.start",
  "device_id": "lab-workstation-a",
  "job": {
    "kind": "firmware-entry",
    "duration_ms": 15000,
    "capture_interval_ms": 1000,
    "key": "F2",
    "key_evidence": "Vendor docs and splash prompt both say F2.",
    "tap_start_ms": 500,
    "tap_interval_ms": 250,
    "tap_duration_ms": 4000
  },
  "execute": true
}
```

Do not qualify with endless tapping. Use a bounded burst, then inspect. There is no built-in learned timing system yet.

## Capability policy

Current public action names that remain unsupported until a verified adapter exists:

- `power.status`
- `power.press`
- `power.reset`
- `power.cycle`
- `media.list`
- `media.mount`
- `media.eject`
- `device.reboot`

Qualification must be read-only by default. Do not probe unknown endpoints by sending live mutation requests just to see what happens.

## Automated tests

Current status to document honestly:

- isolated Linkr implementation tests passing: 15 (76 assertions)
- shared Earendil compatibility suite: 125 passing
- live add-on verification against real hardware: not yet
- browser/UI add-on test: not yet

The isolated tests cover action dispatch, input validation, lease handling, job validation, job retention, and packaged skill discovery. They do not prove live hardware behaviour.

## Important implementation limits to qualify around

- jobs last 1–60 seconds;
- `capture_interval_ms` is 1000–10000 ms;
- firmware tap windows are capped at 5 seconds;
- evidence is capped at 32 MiB per job;
- retention pruning runs only on the next job start and keeps about 20 directories / 24 hours;
- jobs do not resume after restart;
- leases are in-process only.

## Source references

Qualification and testing guidance above is derived from:

- `config.ts` — profile validation
- `extension.ts` — action surface and planning semantics
- `jobs.ts` — job limits, summaries, retention, leases, and persistence
- `client.ts` — transport limits and response validation
- `linkr.test.ts` — current isolated implementation coverage

## Sanitised evidence

Qualification artifacts and recipes should be sanitised before sharing. Exclude:

- tokens and keychain contents;
- local hostnames or private LAN details;
- credentials and recovery keys;
- screenshots containing private user data unless specifically required;
- disk serials or asset identifiers unless required for the operational record.
