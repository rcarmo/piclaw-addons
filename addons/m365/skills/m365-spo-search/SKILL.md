---
name: m365-spo-search
description: Search SharePoint or OneDrive files with KQL queries.
distribution: public
---

# M365 SharePoint Search

Use this skill to find files across SharePoint sites or OneDrive.

## Workflow

1. Use the `m365_spo_search` tool with narrow KQL filters (keywords, paths, `filetype:`).
2. Prefer specific site URLs when available.
3. Return file name, path, and relevance hints.

## Guardrails

- Use `filetype:` filters for precision.
- Prefer targeted site/library URLs over broad tenant-wide searches.
