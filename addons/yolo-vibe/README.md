# @rcarmo/piclaw-addon-yolo-vibe

Quick compose-box YOLO buttons for the PiClaw web UI.

This add-on places three compact buttons in the compose box, floating to the left of the current session button above the text field:

| Button | Submitted prompt |
|---|---|
| Continue | `continue` |
| Audit | `audit for code smells and logic errors, fixing as you go` |
| Docs | `review and update all documentation, then commit and push` |

## Install

Open **Settings → Add-Ons** and install **yolo-vibe** from the catalog.

## Behavior

- Adds browser-side UI only; no runtime tools are registered.
- Sends the prompt to the current chat via the normal `/agent/default/message` backend endpoint.
- Uses `mode: "auto"`, so Piclaw decides whether to send immediately or queue behind an active run.
- Does not modify the current compose draft.

## Notes

This is intentionally a high-friction-reducing workflow add-on. Use the buttons when you explicitly want the agent to continue autonomously, audit/fix code, or update documentation and push.
