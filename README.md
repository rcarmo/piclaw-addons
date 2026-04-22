# piclaw-addons

Extensions, tools, and scripts for [PiClaw](https://github.com/rcarmo/piclaw) workspaces.

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

### Tool installers

| Script | Tool | Size | Dependencies |
|---|---|---|---|
| [install-gh.sh](scripts/install-gh.sh) | GitHub CLI (`gh`) | ~15MB | `curl`, `jq` |
| [install-az.sh](scripts/install-az.sh) | Azure CLI (`az`) | ~50MB | `curl`, `python3` |
| [install-uv.sh](scripts/install-uv.sh) | uv (Python package manager) | ~15MB | `curl` |
| [install-biome.sh](scripts/install-biome.sh) | Biome (linter + formatter) | ~30MB | `curl`, `python3` |
| [install-shellcheck.sh](scripts/install-shellcheck.sh) | ShellCheck (shell linter) | ~10MB | `curl`, `python3` |
| [install-pwsh.sh](scripts/install-pwsh.sh) | PowerShell 7 (standalone) | ~70MB | `curl` |
| [install-dotnet-pwsh.sh](scripts/install-dotnet-pwsh.sh) | .NET SDK 10 + PowerShell 7 | ~235MB | `curl` |
| [install-psscriptanalyzer.sh](scripts/install-psscriptanalyzer.sh) | PSScriptAnalyzer module | ~5MB | `pwsh`, `python3` |
| [add-validator-bicep.sh](scripts/add-validator-bicep.sh) | Bicep validator (`az bicep build`) | — | [`az`](scripts/install-az.sh), `python3` |
| [lib/env-helper.sh](scripts/lib/env-helper.sh) | Shared `.env.sh` helper | — | — |

### Usage

```bash
# Install GitHub CLI
bash scripts/install-gh.sh

# Install Azure CLI
bash scripts/install-az.sh

# Install uv (Python package manager)
bash scripts/install-uv.sh

# Install Biome (JS/TS/JSON/JSONC/CSS linter)
bash scripts/install-biome.sh

# Install ShellCheck (shell linter)
bash scripts/install-shellcheck.sh

# Install PowerShell standalone (lighter, no SDK)
bash scripts/install-pwsh.sh

# Install .NET SDK 10 + PowerShell (when you need dotnet SDK)
bash scripts/install-dotnet-pwsh.sh

# Install PSScriptAnalyzer (requires pwsh — run install-pwsh.sh first)
bash scripts/install-psscriptanalyzer.sh

# Add Bicep validator (requires az cli — run install-az.sh first)
bash scripts/add-validator-bicep.sh
```

### How they work

All scripts:
- Install to `/workspace/.local/` (persists across container restarts)
- Add PATH and config env vars to `/workspace/.env.sh`
- Are idempotent — safe to run multiple times
- Require no `apt install` or root access

### Script dependencies

```
install-gh.sh               (standalone)
install-az.sh               → requires install-uv.sh
install-uv.sh               (standalone)
install-biome.sh            (standalone)
install-shellcheck.sh       (standalone)
install-pwsh.sh             (standalone)
install-dotnet-pwsh.sh      (standalone)
install-psscriptanalyzer.sh → requires install-pwsh.sh OR install-dotnet-pwsh.sh
add-validator-bicep.sh      → requires install-az.sh
```

### Environment persistence

Scripts use `/workspace/.env.sh` as the persistent env hook, sourced from `~/.bashrc`:

```bash
# Add to ~/.bashrc (done automatically by bootstrap-container skill)
[ -f /workspace/.env.sh ] && . /workspace/.env.sh
```

## validators.json

The `code-validator.ts` extension uses `.pi/validators.json` to define custom file validators. The `diagnostics` tool runs matching validators when asked to check a file.

### Schema

```json
{
  "<file-extension>": [
    {
      "cmd": ["command", "arg1", "arg2", "$FILE"],
      "env": { "ENV_VAR": "value" }
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| Key (e.g. `".ps1"`) | string | ✅ | File extension including the dot |
| `cmd` | string[] | ✅ | Command and arguments. `$FILE` is replaced with the absolute file path |
| `env` | object | ❌ | Environment variables set for the validator process |

Multiple validators per extension are supported — they run in sequence.

### Built-in validators (in code-validator.ts)

| Extension | Validator | Command |
|---|---|---|
| `.ts`, `.tsx`, `.js`, `.jsx` | oxlint | `bunx oxlint $FILE` |
| `.py` | py_compile | `python3 -m py_compile $FILE` |
| `.json` | jq | `jq . $FILE` |

### Auto-added by scripts

| Extension | Script | Command |
|---|---|---|
| `.sh` | `install-shellcheck.sh` | `shellcheck $FILE` |
| `.ps1` | `install-psscriptanalyzer.sh` | `Invoke-ScriptAnalyzer -Path $FILE` |
| `.jsonc`, `.css` | `install-biome.sh` | `biome check $FILE` (new coverage) |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.json` | `install-biome.sh` | `biome check $FILE` (alongside built-in oxlint/jq) |
| `.bicep` | `add-validator-bicep.sh` | `az bicep build --file $FILE` (requires [`install-az.sh`](scripts/install-az.sh)) |

### Custom example

```json
{
  ".ps1": [
    {
      "cmd": ["pwsh", "-NoProfile", "-Command",
        "$env:PSModulePath='/workspace/.local/pwsh-modules'; Invoke-ScriptAnalyzer -Path $FILE -Severity Error,Warning | Format-List RuleName,Severity,Line,Message"],
      "env": { "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT": "1" }
    }
  ],
  ".sh": [
    { "cmd": ["shellcheck", "$FILE"] }
  ],
  ".bicep": [
    {
      "cmd": ["az", "bicep", "build", "--file", "$FILE", "--stdout"],
      "env": { "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT": "1" }
    }
  ]
}
```

### Validator output

The validator's stdout and stderr are captured and returned to the agent. Exit code 0 = pass, non-zero = issues found. Format the output as human-readable text (the agent interprets it).

### Adding a new validator

1. Ensure the tool is installed (via an install script or already in PATH)
2. Add an entry to `.pi/validators.json`
3. Use `/restart` to reload the extension
4. Ask the agent: "validate myfile.ps1" or "run diagnostics on script.sh"

## Skills

Drop into `.pi/skills/` to teach the agent how to use specific tools.

| Skill | Description |
|---|---|
| [diagnostics](skills/diagnostics/SKILL.md) | How to use the `diagnostics` tool — supported file types, when to validate, output interpretation |

```bash
cp -r /tmp/piclaw-addons/skills/diagnostics .pi/skills/
```

## Requirements

- [PiClaw](https://github.com/rcarmo/piclaw) container environment
- Extensions require Bun runtime (included in PiClaw)
- Scripts require bash and standard Unix tools

## License

MIT
