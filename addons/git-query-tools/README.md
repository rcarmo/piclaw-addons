# Git Query Tools

Git history and JSON query tools for Piclaw. Requires Piclaw `>=1.8.0`.

## Install

Open **Settings → Add-Ons** and install **git-query-tools** from the catalog. The host must provide `git` and `jq` on `PATH`.

## Tools

### `git_history`

Queries the repository under `/workspace/.pi/extensions` with four modes:

- `log` — recent commits
- `content_search` — commits whose diffs add or remove a string
- `message_search` — commit-message search
- `blame` — line attribution for a file

Optional filters include `file`, `max_count`, `author`, `since`, `diff`, `lines`, `all`, and `ref`. File paths must remain inside the extensions checkout. Process output is bounded and returned in a structured JSON envelope.

### `json_query`

Runs a `jq` expression against either an inline JSON value or one JSON file. Supply exactly one of `input` or `file`. The add-on validates file paths and rejects a small set of risky jq built-ins before execution.

## Skill

The bundled `git-query-tools` skill explains when structured history or JSON queries are clearer than raw shell commands.

## Limits

- Git queries time out after 30 seconds.
- JSON queries time out after 10 seconds.
- Returned output is capped at 200 lines and 50 KiB; subprocess capture is capped at 10 MiB.
