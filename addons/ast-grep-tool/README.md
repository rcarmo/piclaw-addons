# AST Grep

Structural code search and rewrite with the `ast-grep` binary. Requires Piclaw `>=1.8.0`.

## Install

Open **Settings → Add-Ons** and install **ast-grep-tool**. The add-on needs an `ast-grep` executable in its local `node_modules/.bin` directory or on `PATH`:

```bash
bun add @ast-grep/cli
```

## Tools

- `code_search` finds syntax trees using ast-grep metavariables. The default result limit is 100.
- `code_rewrite` performs structural replacement. It defaults to `dry_run: true`; review the preview before setting `dry_run: false`.

Both tools accept a language and optional workspace-relative path. Output is capped at 30,000 characters.

Supported languages: TypeScript, JavaScript, TSX, JSX, Python, Rust, Go, Java, C, C++, C#, Ruby, Swift, Kotlin, Lua, HTML, CSS, JSON, and YAML.

## Skill

The bundled `ast-grep` skill contains search patterns, a safe rewrite workflow, and troubleshooting advice.
