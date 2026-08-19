---
name: m365-profile
description: Fetch the current user profile, manager, or quick calendar windows.
distribution: public
---

# M365 Profile

Use this skill to look up the current user's profile, manager, or calendar events.

## Workflow

1. Use the `m365_profile` tool with the appropriate action (`profile`, `manager`, `calendar_today`, `calendar_upcoming`).
2. For calendar outputs, present clean schedule rows.
3. Highlight conflicts, free windows, or obvious follow-ups.

## Guardrails

- Use this as a quick auth and sanity check before deeper M365 workflows.
