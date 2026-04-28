---
name: ast-grep
description: Use `code_search` and `code_rewrite` for syntax-aware code search and refactors when structure matters.
---

# AST Grep

Use this skill when text search would be noisy or unsafe.

## Use when

- Matching code by shape: calls, imports, declarations, empty blocks, missing branches
- Applying the same structural rewrite across files
- Auditing or banning specific code patterns

## Prefer other tools when

- You need plain text, comments, or strings → `rg`
- You need type/symbol-aware results → `lsp_references` or other LSP tools

## Working rules

- Choose the exact target language; run separate passes for `typescript`/`tsx`, `javascript`/`jsx`, etc.
- Start with `code_search` on a narrow `path`, then use `code_rewrite` in `dry_run`, then apply.
- Keep patterns minimal and valid in the target language; if a pattern fails, simplify and build up.
- Matches are syntax-aware, not semantic: identical code shapes across different symbols can still match.
- After applying rewrites, run diagnostics/tests/formatting.
