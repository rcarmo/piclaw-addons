# pi-skill-model-effort

A Pi package extension that adds runtime support for optional skill frontmatter keys:

- `model` — temporarily switch to a specific model while the skill runs.
- `effort` — temporarily set Pi's thinking level while the skill runs.
- `thinking` — Pi-native synonym for `effort`.

`effort` and `thinking` are mutually exclusive. If both are present, the extension leaves the thinking level unchanged and shows a warning.

## Install

Install from npm:

```bash
pi install npm:pi-skill-model-effort
```

For one-off testing from npm:

```bash
pi -e npm:pi-skill-model-effort
```

## Skill frontmatter

```yaml
---
name: code-review
description: Review code for correctness and maintainability.
model: anthropic/claude-sonnet-4-5
effort: high
---
```

Or use Pi's native term:

```yaml
thinking: xhigh
```

Supported thinking values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
`max` is accepted as an alias for `xhigh` for Claude Code compatibility.

`model: inherit` is treated the same as omitting `model`.

## Behavior

- The model and thinking overrides are temporary and restored at the end of the user prompt/agent run.
- Explicit `/skill:name` invocations are applied as soon as Pi receives the raw slash command, before the first model call for that prompt.
- Automatically selected skills are applied after Pi reads that skill's `SKILL.md`, so the next LLM turn in the same agent run uses the override. The initial model turn that decides to load the skill still uses the current session model/thinking.
- Model references may be `provider/model-id` or an unqualified model id/name if it uniquely matches one configured model.

## Package structure

This repository is a Pi package. `package.json` declares:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/skill-model-effort.ts"]
  }
}
```

Pi loads the TypeScript extension directly via its extension runtime.
