# Session Dashboard

A roll-down dashboard for recent Piclaw sessions. Requires Piclaw `>=2.0.0`.

## Install

Open **Settings → Add-Ons** and install **session-dashboard** from the catalog, then reload Piclaw.

## Use

Open the dashboard from the small tab at the top centre of the web UI, or press backtick when focus is outside an editor or form. Press Escape to close it.

The dashboard shows:

- recent and active session handles
- current activity state
- the latest saved assistant output
- live draft or thinking previews for active sessions
- the current tool invocation when an active session has no draft or thinking text
- context-window usage
- a footer with visible capacity, active count, current chat, and update age

Click a tile to switch through Piclaw's in-app navigation. Ctrl/Cmd-click opens the session in a new tab.

## Live preview priority

For active sessions, the dashboard displays the first available source in this order:

1. assistant draft
2. thinking text
3. current `tool_call` or `tool_status` from `/agent/status`
4. latest saved session summary

Generic `Working...` text is omitted. A specific ongoing state such as `Streaming output...` appears after the tool title. Tool activity uses the interface's monospace font. When a tool finishes, fails, is cancelled, or is aborted, the tile restores the latest non-empty draft or thought from the same turn before falling back to the saved session summary. Transient status-request failures preserve the last live preview. If the runtime omits a precomputed title, the dashboard derives one from common tool arguments such as `command`, `path`, `file`, `url`, or `query`.

## Responsive layout

The panel always uses two rows when enough sessions exist:

- below 760 px: 2 columns, 4 sessions
- 760–1079 px: 3 columns, 6 sessions
- 1080 px and above: 4 columns, 8 sessions

## Refresh behaviour

- full session/context refresh: every 15 seconds while open
- draft/thinking/tool status refresh: every 3 seconds for visible active sessions
- footer age: local DOM update every second
- live event bursts: coalesced before a full refresh

The dashboard does not query model or provider catalogues and makes no external requests.
