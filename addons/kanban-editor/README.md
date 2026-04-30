# @rcarmo/piclaw-addon-kanban-editor

Workspace `.kanban.md` editor add-on for piclaw.

## Install

Open **Settings → Add-Ons** and install **kanban-editor** from the catalog.

## What it does

- registers a `kanban-editor` workspace pane for `.kanban.md` files
- overrides the built-in kanban pane when installed, so the editor can be carved out incrementally into an add-on
- keeps the board editor workflow inside normal workspace tabs
- adds Obsidian-style `[[wiki links]]` between kanban boards

## Wiki links

The add-on supports Obsidian-style `[[wiki links]]` inside kanban card titles so boards can reference other boards directly.

### Supported forms

- `[[ops-roadmap]]` → opens `ops-roadmap.kanban.md`
- `[[boards/ops-roadmap.kanban.md]]`
- `[[ops-roadmap|Ops roadmap]]` → shows a friendly label while still targeting the board file

### Resolution rules

By default, wiki links are treated as links to other `.kanban.md` files.

- bare names default to the `.kanban.md` suffix
- relative paths resolve from the current board's directory
- absolute `/workspace/...` paths are normalized back to workspace-relative board paths
- clicking a wiki link opens the target board in a normal workspace tab/editor

### Example

If you are editing:

- `boards/team/current.kanban.md`

then these resolve as:

- `[[ops-roadmap]]` → `boards/team/ops-roadmap.kanban.md`
- `[[../shared/backlog]]` → `boards/shared/backlog.kanban.md`
- `[[../shared/backlog|Shared backlog]]` → same target, custom visible label

This makes it easier to split related planning work across multiple boards and jump between them from inside the board itself.

## Extraction status

This is the current extraction status.

- the add-on registers a `kanban-editor` workspace pane for `.kanban.md` files
- piclaw core no longer registers or ships the built-in kanban pane/runtime assets
- the add-on now owns specialized kanban pane registration and ships its own kanban JS/CSS assets through the add-on asset route
- without the add-on installed, `.kanban.md` files fall back to the normal editor path

The kanban board UI is now fully carved out of piclaw core and lives in this add-on.
