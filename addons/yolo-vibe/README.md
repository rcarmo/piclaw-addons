# @rcarmo/piclaw-addon-yolo-vibe

Quick compose-box YOLO buttons for the PiClaw web UI.

Requires Piclaw `>=2.0.0`.

This add-on mounts three compact buttons **inside the compose box**, on the bottom action row next to the send/search controls. They stay partially transparent until you hover or focus the compose box (or the buttons themselves), then become fully opaque:

| Button | Submitted prompt |
|---|---|
| Continue | `continue, according to plan` |
| Audit | `audit for code smells and logic errors, fixing as you go` |
| Docs | `review and update all documentation, then commit and push` |

## Install

Open **Settings → Add-Ons** and install **yolo-vibe** from the catalog.

## Behavior

- Adds browser-side UI only; no runtime tools are registered.
- Buttons are inserted into the compose action bar (`.compose-actions`), so they are bottom-aligned with the existing controls and scroll/move with the compose box.
- Partially transparent by default; full opacity on compose-box hover/focus or button hover.
- Sends the prompt to the current chat via the normal `/agent/default/message` backend endpoint.
- Uses `mode: "auto"`, so Piclaw decides whether to send immediately or queue behind an active run.
- Does not modify the current compose draft.

## Notes

This is intentionally a high-friction-reducing workflow add-on. Use the buttons when you explicitly want the agent to continue autonomously, audit/fix code, or update documentation and push.
