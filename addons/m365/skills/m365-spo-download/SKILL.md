---
name: m365-spo-download
description: Download a SharePoint or OneDrive file to the local workspace.
distribution: public
---

# M365 SharePoint Download

Use this skill to download files from SharePoint or OneDrive.

## Workflow

1. Validate the source site URL and file path.
2. Use the `m365_spo_download` tool to download to a deterministic local path.
3. Report the output file path and size.

## Guardrails

- State exact source and destination paths before downloading.
- Avoid overwriting sensitive local files accidentally.
