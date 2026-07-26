# Code Validator

The `diagnostics` tool validates workspace code files. Requires Piclaw `>=1.8.0`.

## Install

Open **Settings → Add-Ons** and install **code-validator** from the catalog. Install the validator binaries needed by your project.

## Built-in validators

| Files | Command |
|---|---|
| `.ts`, `.tsx`, `.js`, `.jsx` | `bunx oxlint <file>` |
| `.py` | `python3 -m py_compile <file>` |
| `.json` | `jq . <file>` |

Call `diagnostics` without a file to list the configured extensions and commands. Missing binaries are reported as warnings rather than hard failures.

## Custom validators

Add validators in `/workspace/.pi/validators.json`. Each extension may map to one command or an array of commands; use `$FILE` where the validated path belongs.

```json
{
  ".go": { "command": ["go", "test", "$FILE"] }
}
```

## Limits

- file paths must remain under `/workspace`
- each validator has a 30-second timeout
- process capture is capped at 10 MiB
- displayed diagnostics are truncated to 30 lines per validator
