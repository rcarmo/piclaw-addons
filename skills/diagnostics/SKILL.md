---
name: diagnostics
description: Validate code files using the diagnostics tool. Supports JS/TS, Python, JSON, PowerShell, shell scripts, Bicep, and more via .pi/validators.json.
distribution: public
---

# Diagnostics

Use the `diagnostics` tool to validate code files for syntax errors, lint issues, and type problems.

## Quick start

```
# List all available validators and supported file types
diagnostics({})

# Validate a specific file
diagnostics({ file: "path/to/file.ts" })
```

## Supported file types

### Built-in (always available)

| Extension | Validator | What it checks |
|---|---|---|
| `.ts`, `.tsx`, `.js`, `.jsx` | oxlint | Lint issues (via `bunx oxlint`) |
| `.py` | py_compile | Syntax errors |
| `.json` | jq | JSON syntax validation |

### Custom (via .pi/validators.json)

| Extension | Validator | What it checks |
|---|---|---|
| `.ps1` | PSScriptAnalyzer | PowerShell lint — Write-Host usage, unused variables, best practices |
| `.sh` | ShellCheck | Shell script lint — quoting, globbing, syntax |
| `.bicep` | az bicep build | Bicep syntax and type errors |
| `.jsonc`, `.css` | Biome | Lint + format validation |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.json` | Biome | Additional lint alongside oxlint/jq |

Custom validators are defined in `/workspace/.pi/validators.json`.

## When to use

- After writing or editing a code file
- Before committing changes
- When debugging syntax or lint errors
- To validate infrastructure code (Bicep, Terraform)

## Interpreting output

- **Exit code 0** with no output = file is valid
- **Non-zero exit** with error messages = issues found, fix them
- Multiple validators may run for the same file type — all results are combined

## Adding new validators

Edit `/workspace/.pi/validators.json`:

```json
{
  ".ext": [
    {
      "cmd": ["tool", "arg", "$FILE"],
      "env": { "OPTIONAL_ENV": "value" }
    }
  ]
}
```

`$FILE` is replaced with the absolute file path at runtime.

Use `/restart` to reload after editing validators.json.
