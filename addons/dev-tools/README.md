# Dev Tools

Structured Git-history and JSON-query tools for Piclaw. Requires Piclaw `>=1.8.0`, `git`, and `jq` on `PATH`.

## Install

Open **Settings → Add-Ons** and install **dev-tools** from the catalog.

## Tools

### `git_history`

Modes:

- `log` — recent commits
- `content_search` — find a string in commit diffs
- `message_search` — search commit messages
- `blame` — attribute file lines

Filters include file, author, date, ref, all branches, patch output, maximum count, and blame line range.

### `json_query`

Runs a jq expression against exactly one source: a workspace file or inline JSON input. The tool validates paths and blocks risky jq built-ins and patterns.

## Limits

- file paths must remain under `/workspace`
- Git queries time out after 30 seconds
- jq queries time out after 10 seconds
- returned output is capped at 200 lines and 50 KiB
- subprocess capture is capped at 10 MiB

Both tools return structured JSON envelopes and show progress in interactive sessions.
