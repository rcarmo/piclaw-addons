---
name: ast-grep
description: Use `code_search` and `code_rewrite` for syntax-aware code search and refactors when structure matters.
---

# AST Grep

Use this skill when text search would be noisy or unsafe.

## Tools
- `code_search(pattern, lang, path?, limit?)` — find code by AST pattern
- `code_rewrite(pattern, rewrite, lang, path?, dry_run?)` — structural find-and-replace

## Examples
- `console.log($MSG)` — find all console.log calls
- `var $NAME = $VAL` → `const $NAME = $VAL` — modernize var declarations
- `catch ($ERR) { }` — find empty catch blocks
- `import $X from "lodash"` — find imports from a specific module

## Workflow
1. `code_search(pattern, lang, path, limit=20)` — narrow path, sample first
2. Inspect matches — verify pattern catches what you want
3. `code_rewrite(pattern, rewrite, lang, path, dry_run=true)` — preview changes
4. Review the dry run output
5. `code_rewrite(pattern, rewrite, lang, path, dry_run=false)` — apply
6. Read changed files, run formatting/tests

## Prefer other tools when
- You need plain text, comments, or strings → `grep`
- You need type/symbol-aware results → LSP/symbol tools if available

## Safety
- Always run `dry_run=true` before applying any rewrite
- Scope with `path` to avoid unintended matches in vendored/generated code
- Supported `lang` values: typescript, javascript, tsx, jsx, python, rust, go, java, c, cpp, csharp, ruby, swift, kotlin, lua, html, css, json, yaml
- After applying rewrites, read changed files and run tests/formatting before moving on

## Troubleshooting
- No matches: verify `lang` is correct (e.g. `typescript` not `ts`), broaden pattern
- Too many matches: narrow `path`, add more structure to pattern, lower `limit`
- Pattern error: simplify — patterns must be valid syntax in the target language
- Wrong language: `typescript` ≠ `tsx`, `javascript` ≠ `jsx` — run separate passes
