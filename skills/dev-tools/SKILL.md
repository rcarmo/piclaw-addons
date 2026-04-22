---
name: dev-tools
description: git_history and json_query tools for structured git log exploration and jq-style JSON querying.
distribution: public
---

# Dev Tools

Two workspace tools for structured data queries.

## git_history

Prefer over raw `git log` commands. Returns structured JSON with truncation.

```
git_history({ mode: "log", limit: 10 })              # recent commits
git_history({ mode: "search", query: "fix bug" })     # search commit messages
git_history({ mode: "code-search", query: "TODO" })   # search code history
git_history({ mode: "blame", file: "path/to/file" })  # file blame
```

## json_query

Prefer over shell `jq` piping. Validates expressions and returns structured output.

```
json_query({ file: "data.json", query: ".items[] | .name" })
json_query({ input: '{"a":1}', query: ".a" })
```
