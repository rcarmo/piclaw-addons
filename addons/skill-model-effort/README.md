# Skill Model Effort

First-party Piclaw packaging of Rob Zolkos's MIT-licensed [`pi-skill-model-effort`](https://github.com/robzolkos/pi-skill-model-effort) extension.

This add-on honors optional skill frontmatter keys at runtime:

- `model` — temporarily switches to the requested model while the skill runs
- `effort` — temporarily sets Piclaw/Pi thinking level while the skill runs
- `thinking` — native synonym for `effort`

`effort` and `thinking` are mutually exclusive. If both are present, the add-on leaves thinking unchanged and shows a warning.

## Skill frontmatter example

```yaml
---
name: code-review
description: Review code for correctness and maintainability.
model: anthropic/claude-sonnet-4-5
effort: high
---
```

Supported thinking values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. `max` is accepted as an alias for `xhigh`.

## Behavior

- Explicit `/skill:name` invocations apply the override as soon as Piclaw receives the raw slash command.
- Automatically selected skills apply after Piclaw reads that skill's `SKILL.md`; the next LLM turn in the same run uses the override.
- Model/thinking settings are restored at agent end.
- `model: inherit` is treated as no model override.

## Upstream

- Source: <https://github.com/robzolkos/pi-skill-model-effort>
- Upstream package: `pi-skill-model-effort`
- License: MIT — copied as [`LICENSE.upstream`](./LICENSE.upstream)
- Upstream README: [`README.upstream.md`](./README.upstream.md)
