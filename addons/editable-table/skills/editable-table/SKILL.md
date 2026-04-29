---
name: editable-table
description: Open a spreadsheet-style widget for a Markdown table so the user can edit it and send the final Markdown table back into chat.
distribution: public
---

# Editable Table

Use this when the user needs to:

- fill in or correct a table,
- edit structured rows and columns visually,
- review tabular content before sending it back to the agent.

## Tool

- `editable_table`

## Input

Pass a valid Markdown table.

Example:

```markdown
| Name | Role | Notes |
| --- | --- | --- |
| Alice | PM | |
| Bob | Eng | owns API |
```

## Behavior

- Opens a themed spreadsheet-style widget in the web UI.
- The user edits the grid visually.
- When they click **Insert into chat**, the widget submits the updated content back as a Markdown table.
- The submitted Markdown table becomes a user message, so the agent can read it directly.

## Guidance

- Prefer this over asking the user to manually edit Markdown when visual table editing is clearly better.
- Keep the initial table compact and meaningful.
- After opening the widget, wait for the user’s submitted Markdown table before continuing.
- Do not reformat the user’s returned table unless they ask.
