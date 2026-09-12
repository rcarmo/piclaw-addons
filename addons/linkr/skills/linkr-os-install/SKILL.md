---
name: linkr-os-install
description: Conduct an operator-supervised operating-system installation through the native linkr tool, with explicit installer checkpoints, disk-write approval, credential handoff, and post-install verification.
distribution: public
---

# Linkr OS install

Use this skill only for authorised installation or reinstallation of an operating system on a specifically identified target machine.

This skill is intentionally conservative. It should stop on ambiguity rather than guess.

## Required installation brief

Before beginning, obtain and restate:

- target profile and `targetIdentity`;
- OS name, version, edition, and architecture;
- verified ISO or installer source and checksum status;
- intended boot path, such as physical USB; virtual media is not implemented in v0.1;
- target disk identity and capacity;
- keep/erase policy;
- backup or disposable-device evidence;
- encryption plan;
- network constraints;
- post-install access plan.

If the task lacks a clearly identified target disk, stop.

## Media rules

`media.mount` and `media.eject` are public action names, but they are currently unsupported in this add-on. The operator must provide physical or separately managed install media.

## Installer workflow

At each installer screen:

1. Capture `snapshot`.
2. Describe the visible state and any ambiguity.
3. Choose one small next step.
4. Preview the HID action.
5. Re-run with `execute:true`.
6. Verify with a new `snapshot`.

Typical checkpoints include:

- language and locale;
- keyboard layout;
- install versus rescue mode;
- storage or partitioning mode;
- disk selection;
- encryption and recovery-key prompts;
- user creation;
- bootloader target;
- final write summary.

## Final disk-write approval

A general request like “install Linux” is **not** enough authority to pick a disk or erase data.

Pause at the actual final summary that commits disk changes and restate:

- selected disk by visible label/model/size;
- visible partitions or deletions;
- encryption decision;
- any warning about data loss.

Proceed only after explicit approval at that screen.

## Secure Boot, TPM, and storage mode

Do not disable Secure Boot, TPM, or change storage-controller mode merely to make an installer continue. If those settings become blockers, stop and ask for explicit scope expansion.

## Credentials and operator handoff

Do not place passwords, recovery keys, or long secrets into tool text, screenshots you plan to share, or reusable recipes.

If secret entry cannot be done safely without exposing the secret to retained model context or captured artifacts, hand that step to the operator.

## Long-running installs

Do not reset or power-cycle just because the installer looks idle for a while. Distinguish:

- genuine progress;
- long but normal package extraction;
- reboot wait screens;
- clear error dialogs.

No power cuts during updates or firmware changes.

## Post-install verification

After reboot:

- ensure install media is not still winning the boot path;
- eject or detach media only when safe and only if a future verified media method exists;
- verify the visible OS actually booted;
- report whether login, network, and expected OS version are observable.

A login screen alone is useful evidence, but it is not proof that all requested post-install work is complete.
