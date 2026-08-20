---
name: m365-teams-chats
description: Enumerate Teams conversations to locate the correct thread ID.
distribution: public
---

# M365 Teams Chats

Use this skill to list Teams chat conversations (DMs, group chats, meetings).

## Workflow

1. Use the `m365_teams_chats` tool to list recent chats.
2. Identify the relevant chat by topic or participants.
3. Use the returned chat ID with `m365_teams_messages` or `m365_teams_send`.
