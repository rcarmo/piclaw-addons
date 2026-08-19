---
name: m365-graph-query
description: Run targeted Microsoft Graph queries across mail, calendar, users, and files.
distribution: public
---

# M365 Graph Query

Use this skill when you need to query the Microsoft Graph REST API directly.

## Workflow

1. Build a narrow path with `$select` and `$top` when applicable.
2. Execute the query via the `m365_graph_query` tool.
3. Return a compact JSON summary plus the key fields.

## Guardrails

- Always bound result size with `$top`.
- Prefer `v1.0` unless `beta` is explicitly needed.
- Avoid broad tenant-wide queries without user confirmation.
