---
name: m365-document-link-metadata
description: Resolve Teams or SharePoint document links to canonical metadata.
distribution: public
---

# M365 Document Link Metadata

Use this skill to resolve a SharePoint, Teams, or OneDrive document URL to its canonical metadata.

## Workflow

1. Use the `m365_document_link_metadata` tool with the document URL.
2. Returns the canonical URL, file name, and preview image URL when available.

## Uses

- Pre-flight before sharing, downloading, or posting file cards to Teams.
- Resolving ambiguous or redirect-heavy document links.
