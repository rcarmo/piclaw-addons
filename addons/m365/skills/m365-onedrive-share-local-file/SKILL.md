---
name: m365-onedrive-share-local-file
description: Upload a local file to OneDrive and generate a read-only share link.
distribution: public
---

# M365 OneDrive Share Local File

Use this skill to upload a workspace file to OneDrive and create a shareable link.

## Workflow

1. Validate that the local file exists.
2. Use the `m365_onedrive_share_local_file` tool to upload to the target OneDrive folder.
3. Return the share URL and final file name.

## Guardrails

- Confirm sharing scope expectations with the user, especially when broader than organization-only.
- State exact source path and target folder before uploading.
