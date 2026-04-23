# piclaw-addons

Add-ons, extensions, tools, and scripts for [PiClaw](https://github.com/rcarmo/piclaw) workspaces.

## Add-ons

Each add-on lives in `addons/<slug>/` with a standard `package.json` manifest.

| Add-on | Description |
|---|---|
| [code-validator](addons/code-validator/) | `diagnostics` tool — code validation for Python, JS/TS, JSON with extensible validators via `.pi/validators.json` |
| [dev-tools](addons/dev-tools/) | `git_history` + `json_query` tools — git log exploration and jq-style JSON querying |
| [kanban-board-widget](addons/kanban-board-widget/) | `/board` slash command — interactive kanban board widget with drag & drop and workitem management |

### Installing an add-on

From inside your PiClaw workspace:

```bash
# Install a single add-on
bun add github:rcarmo/piclaw-addons/addons/code-validator

# Or install directly into the extensions directory
cd .pi/extensions
bun add github:rcarmo/piclaw-addons/addons/dev-tools
```

After installing, restart PiClaw (`exit_process` from the agent or container restart).

### Manual installation

If you prefer not to use `bun add`, you can copy the extension file directly:

```bash
# Copy a single extension into .pi/extensions/
curl -sL https://raw.githubusercontent.com/rcarmo/piclaw-addons/main/addons/code-validator/index.ts \
  -o .pi/extensions/code-validator.ts
```

### Prerequisites

Workspace extensions import packages from PiClaw's global install (`@sinclair/typebox`, `@mariozechner/pi-coding-agent`, etc.). PiClaw automatically creates a `node_modules` symlink in `.pi/extensions/` on startup. If it's missing, create it manually:

```bash
ln -sf /usr/local/lib/bun/install/global/node_modules .pi/extensions/node_modules
```

## Catalog

The [`catalog.json`](catalog.json) file provides a machine-readable index of all available add-ons. PiClaw's built-in Settings pane (`/settings` → Add-ons) fetches this file to display the available add-on list.

### Manifest format

Each add-on has a `package.json` following the NPM package format with a `piclaw` extension field:

```json
{
  "name": "piclaw-addon-example",
  "version": "0.1.0",
  "description": "What this add-on does",
  "type": "module",
  "main": "index.ts",
  "piclaw": {
    "type": "extension",
    "compatibleVersions": ">=1.8.0",
    "tags": ["category1", "category2"]
  },
  "license": "MIT"
}
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | NPM-style package name (`piclaw-addon-*` convention) |
| `version` | yes | Semver version |
| `description` | yes | Human-readable description |
| `main` | yes | Extension entrypoint (TypeScript file) |
| `piclaw.type` | yes | Always `"extension"` for now |
| `piclaw.compatibleVersions` | yes | Semver range for compatible PiClaw versions |
| `piclaw.tags` | no | Array of category tags for filtering |

## Legacy extensions

The original single-file extensions are still available in `extensions/` for backward compatibility:

| Extension | Description |
|---|---|
| [kanban-board-widget.ts](extensions/kanban-board-widget.ts) | Interactive kanban board widget |
| [dev-tools.ts](extensions/dev-tools.ts) | Git history + JSON query tools |
| [code-validator.ts](extensions/code-validator.ts) | Code validation diagnostics |

## Scripts

Helper scripts for installing common development tools into a PiClaw workspace:

| Script | Description |
|---|---|
| [install-gh.sh](scripts/install-gh.sh) | GitHub CLI |
| [install-uv.sh](scripts/install-uv.sh) | uv (Python package manager) |
| [install-shellcheck.sh](scripts/install-shellcheck.sh) | ShellCheck |
| [install-biome.sh](scripts/install-biome.sh) | Biome (JS/TS linter) |
| [install-pwsh.sh](scripts/install-pwsh.sh) | PowerShell |
| [install-dotnet-pwsh.sh](scripts/install-dotnet-pwsh.sh) | .NET + PowerShell |
| [install-az.sh](scripts/install-az.sh) | Azure CLI |

## Skills

| Skill | Description |
|---|---|
| [dev-tools](skills/dev-tools/) | Developer tool guidance |
| [diagnostics](skills/diagnostics/) | Diagnostic workflow guidance |
| [install-addons](skills/install-addons/) | Add-on installation helper |

## Licence

MIT
