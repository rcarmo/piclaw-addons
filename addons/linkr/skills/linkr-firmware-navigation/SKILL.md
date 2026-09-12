---
name: linkr-firmware-navigation
description: Navigate BIOS or UEFI screens through the native linkr tool one observed step at a time, preserving original values and avoiding unsafe assumptions about keys, tabs, save semantics, or security settings.
distribution: public
---

# Linkr firmware navigation

Use this skill only after a firmware or boot-management screen is visibly open.

Firmware is not portable UI. Every step must be justified by what is visible on the current screen.

## Workflow

1. Capture `snapshot` and identify:
   - screen title;
   - highlighted item;
   - visible navigation legend;
   - visible current values;
   - warning banners or password prompts.
2. State what you believe the current menu is and why.
3. Choose one menu transition or one value change only.
4. Preview the needed HID action using the exact implemented fields.
5. Re-run with `execute:true`.
6. Capture a fresh `snapshot` and verify the transition actually occurred.

## Navigation principles

- Use the actual visible legend if present.
- Do not assume `F10`, `Escape`, or mouse support are portable.
- Do not assume tab labels imply keyboard focus order.
- Do not use fixed coordinates unless the UI visibly shows mouse support and the captured geometry is clear.
- Treat Save, Apply, Discard, and Exit as separate semantics.

## Change ledger

Before changing any setting, record:

- menu path;
- current value;
- intended new value;
- reason for the change.

After the change, capture the observed new value and whether it still requires Save or Apply.

## Explicitly protected settings

Do not casually alter:

- Secure Boot;
- TPM or firmware security state;
- storage controller mode;
- virtualization security features;
- firmware passwords.

These require explicit scope and, where relevant, operator participation.

## Password and credential handling

If firmware asks for a password:

- do not attempt bypasses;
- do not guess vendor defaults;
- obtain operator-supplied credentials through an agreed secure handoff, or hand control to the operator.

## Current limitations

There is no built-in semantic firmware detector or durable resume. If a screen transition is missed, observe again and correct one step at a time.

## What counts as success

Success is not “a key was sent.” Success is a verified visual transition or a verified settings change supported by a new `snapshot`.
