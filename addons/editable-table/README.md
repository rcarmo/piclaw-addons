# @rcarmo/piclaw-addon-editable-table

Editable Markdown table widget for the PiClaw web UI.

This add-on opens a spreadsheet-style floating widget for a Markdown table, lets the user edit it visually, and inserts the final result back into chat as a Markdown table so the agent can read it.

## Install

Open **Settings → Add-Ons** and install **editable-table** from the catalog.

## Tool

- `editable_table`

## Input format

Provide a Markdown table:

```markdown
| Task | Owner | Status |
| --- | --- | --- |
| Docs | Rui | in progress |
| Add-on | Smith | ready |
```

## Output format

When the user clicks **Insert into chat**, the widget sends the edited content back into the conversation as a plain Markdown table.

## Design goals

- spreadsheet-like editing with direct `contenteditable` cells instead of a wall of input boxes
- PiClaw theme-aware styling
- minimal dependencies (v1 uses a dependency-free grid)
- clean Markdown in and clean Markdown out
