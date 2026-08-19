---
name: m365-mail
description: List, search, or read mailbox messages via Microsoft Graph.
distribution: public
---

# M365 Mail

Use this skill to work with Outlook mail messages.

## Workflow

1. Start with `action=list` or a constrained `action=search` via the `m365_mail` tool.
2. Open specific messages by ID with `action=read`.
3. Summarize sender, subject, date, and action items.
4. For drafts and replies, use `action=draft`, `action=reply`, or `action=forward` — these create drafts only, never send directly.
5. Attach local files with `attachments='path1;path2'` (max 3MB per file, semicolon-separated).

## Guardrails

- Avoid dumping full message bodies unless the user requests it.
- Keep results scoped with `top`.
- For batch operations (`batch_delete`, `batch_move`, `batch_archive`, `batch_flag`), always use `dryRun=true` first.
- Confirm with the user before destructive actions.
