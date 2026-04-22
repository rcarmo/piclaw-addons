# piclaw-addons

Extensions, tools, and scripts for [PiClaw](https://github.com/mariozechner/piclaw) workspaces.

## Extensions

Drop any `.ts` file into your `.pi/extensions/` directory and restart PiClaw (`exit_process` or container restart).

| Extension | Description |
|---|---|
| [kanban-board-widget.ts](extensions/kanban-board-widget.ts) | `/board` slash command — interactive kanban board widget with drag & drop, ticket detail views, and workitem management |
| [dev-tools.ts](extensions/dev-tools.ts) | `git_history` + `json_query` tools — git log exploration and jq-style JSON querying |
| [code-validator.ts](extensions/code-validator.ts) | `diagnostics` tool — code validation for Python, JS/TS, JSON with extensible validators via `.pi/validators.json` |

### Installation

```bash
# From inside the PiClaw container
curl -sL https://raw.githubusercontent.com/rcarmo/piclaw-addons/main/extensions/kanban-board-widget.ts -o .pi/extensions/kanban-board-widget.ts
curl -sL https://raw.githubusercontent.com/rcarmo/piclaw-addons/main/extensions/dev-tools.ts -o .pi/extensions/dev-tools.ts
curl -sL https://raw.githubusercontent.com/rcarmo/piclaw-addons/main/extensions/code-validator.ts -o .pi/extensions/code-validator.ts
```

Or clone and copy:

```bash
git clone https://github.com/rcarmo/piclaw-addons.git /tmp/piclaw-addons
cp /tmp/piclaw-addons/extensions/*.ts .pi/extensions/
```

Then restart PiClaw to load the extensions.

## Scripts

Workspace setup scripts for persistent tool installation across container restarts.

| Script | Description |
|---|---|
| [install-gh.sh](scripts/install-gh.sh) | Install GitHub CLI (`gh`) to `/workspace/.local/bin/` with persistent PATH via `.env.sh` |
| [install-az.sh](scripts/install-az.sh) | Install Azure CLI (`az`) via `uv tool` to `/workspace/.local/bin/` with persistent config |
| [install-uv.sh](scripts/install-uv.sh) | Install uv — fast Python package manager with `uvx` for one-off tool execution |
| [install-dotnet-pwsh.sh](scripts/install-dotnet-pwsh.sh) | Install .NET SDK 10 + PowerShell 7 as .NET global tool. Uses invariant globalization (no libicu) |
| [install-pwsh.sh](scripts/install-pwsh.sh) | Install PowerShell 7 standalone (~70MB, bundled .NET runtime, no SDK needed) |
| [lib/env-helper.sh](scripts/lib/env-helper.sh) | Shared helper for idempotent `.env.sh` line management |

### Usage

```bash
# Install GitHub CLI
bash scripts/install-gh.sh

# Install Azure CLI
bash scripts/install-az.sh

# Install uv (Python package manager)
bash scripts/install-uv.sh

# Install .NET SDK 10 + PowerShell (when you need dotnet SDK)
bash scripts/install-dotnet-pwsh.sh

# Install PowerShell standalone (lighter, no SDK)
bash scripts/install-pwsh.sh
```

Both scripts:
- Install binaries to `/workspace/.local/bin/` (persists across container restarts)
- Add PATH and config env vars to `/workspace/.env.sh`
- Are idempotent — safe to run multiple times

### Environment persistence

Scripts use `/workspace/.env.sh` as the persistent env hook, sourced from `~/.bashrc`:

```bash
# Add to ~/.bashrc (done automatically by bootstrap-container skill)
[ -f /workspace/.env.sh ] && . /workspace/.env.sh
```

## Requirements

- [PiClaw](https://github.com/mariozechner/piclaw) container environment
- Extensions require Bun runtime (included in PiClaw)
- Scripts require bash and standard Unix tools

## License

MIT
