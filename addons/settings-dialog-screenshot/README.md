# @rcarmo/piclaw-addon-settings-dialog-screenshot

## Install

Open **Settings → Add-Ons** and install **settings-dialog-screenshot** from the catalog.

Developer add-on for capturing screenshots of the Pi web settings dialog, cropped to the dialog window only.

## Included skill

- `settings-dialog-screenshot`

## Purpose

Use this when documenting Pi/piclaw settings panes or add-ons and you need:

- a screenshot of the settings dialog only
- a tight crop around the dialog window
- no full-page browser chrome unless unavoidable

## Development notes

This add-on follows the repository conventions in the root `AGENTS.md`.

In practice that means:

- keep the add-on self-contained under `addons/settings-dialog-screenshot/`
- keep the skill in `skills/settings-dialog-screenshot/SKILL.md`
- run `bun run sync:catalog` after package metadata changes
- use `bun run check:catalog` to validate metadata sync
- bump the package version on functional changes
- avoid importing piclaw runtime internals directly

If you extend this add-on, the canonical contributor guidance is in the repository root:

- `AGENTS.md`

## Notes

This is a skill-only add-on intended for piclaw development and documentation workflows.
