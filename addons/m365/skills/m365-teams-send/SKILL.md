---
name: m365-teams-send
description: Send a message to a Teams thread, optionally with an attachment card.
distribution: public
---

# M365 Teams Send

Use this skill when you need to send a message to a Teams conversation.

## Workflow

1. Draft the proposed message text.
2. Get **explicit user confirmation** before sending.
3. Use `m365_teams_send` (plain text), `m365_teams_send_rich_text` (markdown → HTML), or the file-card tools for attachments.
4. Return confirmation metadata after sending.

## Guardrails

- **Always confirm** with the user before sending any Teams message.
- Use `dryRun=true` to preview without sending.
- Keep outbound text concise and context-aware.
