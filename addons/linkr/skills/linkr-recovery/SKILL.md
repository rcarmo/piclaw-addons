---
name: linkr-recovery
description: Troubleshoot and recover a Linkr-controlled machine with the least disruptive supported action first, preserving evidence and avoiding speculative power or media operations.
distribution: public
---

# Linkr recovery

Use this skill for recovery and troubleshooting when a machine behind Linkr is not booting, not responding as expected, or appears to be in an ambiguous state.

## Common cases

This skill covers:

- missed firmware-entry windows;
- boot loops;
- no-signal or black-screen reports;
- wrong keyboard layout or stuck modifiers;
- wrong boot target;
- missing install media;
- lost confidence in whether prior HID input delivered;
- unexpected firmware or recovery screens.

## Recovery order

Prefer the least disruptive supported action first:

1. `status`
2. `snapshot`
3. read-only `capabilities`
4. tiny corrective HID actions with preview first
5. `input.release` for suspected stuck key/button state
6. `reboot.plan` or `firmware.entry.plan` if a bounded retry is justified
7. operator-assisted physical intervention if tooling is insufficient

Do not jump straight to reset or power cycle.

## Distinguish ambiguity sources

A black or static screen can mean different things:

- stale snapshot;
- resolution or mode change;
- monitor asleep but machine running;
- Linkr transport issue;
- attached machine off;
- firmware open at a display mode that looks different from expected.

Name the uncertainty instead of pretending the cause is known.

## Unsafe recovery actions

Do not power-cycle during:

- firmware flashing;
- OS or package updates;
- disk encryption setup or recovery-key generation;
- filesystem repair;
- partition resize or migration.

Treat `power.press`, `power.reset`, `power.cycle`, `media.mount`, `media.eject`, and `device.reboot` as unavailable unless the selected profile has verified support.

## Cancellation and uncertain delivery

- `job.cancel` may acknowledge cancellation before a running job has fully stopped.
- A failed or interrupted HID send can leave input state uncertain.
- Observe first.
- Use `input.release` only for tracked uncertain state; it cannot undo already applied actions.

## Firmware and bootloader repair

Bootloader repair, partition editing, Secure Boot or TPM changes, and password-reset work all require explicit scope. They are not implicit in a generic “please fix it” request.

## Manual intervention detection

If the screen changes in a way that does not match the planned step, consider:

- another administrator;
- a local keyboard/mouse user;
- watchdog or out-of-band reboot;
- different hardware now attached to the same Linkr.

Pause and reconcile before sending more input.

## Success criteria

A recovery action is successful only when a fresh `snapshot` shows a safer or more intelligible state, or when the operator confirms the recovered state through another trusted channel.
