# Session Tree

Interactive renderer for Piclaw's session-tree widget. Requires Piclaw `>=1.8.0`.

## Install

Open **Settings → Add-Ons** and install **session-tree** from the catalog, then reload Piclaw.

## Behaviour

The add-on registers the `session_tree` widget kind through `globalThis.__piclaw_registerWidgetKind`. Piclaw's `/tree` command can then display an interactive tree instead of its text fallback.

The widget:

- fetches the current tree from `/agent/session-tree`
- highlights the active leaf
- expands and collapses branches
- filters by ID, label, or summary
- refreshes on demand
- submits `/tree <id>` when a row is selected

If the host does not expose the widget registry, the add-on logs a warning and Piclaw keeps the normal text response.

## Scope

This package provides only the browser widget renderer. Piclaw core owns the `/tree` command and session-tree API.
