---
name: linkr-boot-selection
description: Select a one-time boot target or perform an explicitly requested persistent boot-order change through observed firmware screens, using visible device identity rather than ordinal guesses.
distribution: public
---

# Linkr boot selection

Use this skill when the task is to boot from a specific device, installer, recovery partition, or network target visible through firmware or a boot menu.

## First question: one-time or persistent?

Prefer a **one-time boot override** when the need is temporary, such as installation or recovery. A persistent boot-order change is a distinct requested outcome and needs extra care.

State which of these is intended before sending input.

## Identification rules

Choose entries by visible evidence, not guesswork:

- entry label;
- device type;
- model name;
- capacity;
- UEFI versus legacy marker;
- recovery or vendor-reserved wording.

Never select a disk or boot entry by ordinal position alone.

## Workflow

1. Use `snapshot` to identify the boot-menu or firmware screen.
2. State the current top entry or current boot order if visible.
3. State the exact desired target and why it matches the requested task.
4. For persistent order changes, record the prior order before editing.
5. Preview the next HID step with the exact `device_id` and action fields.
6. Re-run with `execute:true`.
7. Verify the selection or reordered list with another `snapshot`.

## Persistence rules

For persistent changes, keep a ledger of:

- prior order;
- proposed order;
- reason;
- save confirmation screen;
- next observed boot result.

If the user only asked to boot once from install media, do not leave that media first in the persistent order.

## Narrow-tap rule

Once a boot menu or firmware screen opens, key semantics can change quickly. Use short, narrow taps and re-observe often. Do not keep pressing the boot key after the target screen is open.

## Current limitations

There is no true `screen.compare` or learned boot-menu timing in v0.1. Use visible evidence and fresh snapshots, not assumed menu geometry.

## Network boot caution

Do not select PXE or other network boot targets unless the trusted server and intended environment are already established. This skill does not authorise network discovery or broad boot experimentation.

## Completion

Report whether the result was:

- one-time selection only;
- persistent order change;
- ambiguous;
- aborted due to unclear device identity.
