# piclaw-addons

Community add-ons for [piclaw](https://github.com/rcarmo/piclaw) — extensions, skills, and widgets.

## Install

```bash
# From the .pi/extensions directory:
cd /workspace/.pi/extensions
bun add github:rcarmo/piclaw-addons/addons/<slug>

# Example:
bun add github:rcarmo/piclaw-addons/addons/code-validator
```

After installing, restart piclaw to load the extension.

## Available Add-ons

| Add-on | Type | Version | Description | Skills |
|--------|------|---------|-------------|--------|
| [autoresearch](addons/autoresearch) | extension | 0.1.0 | Autonomous experiment loop sub-agent | autoresearch-create |
| [code-validator](addons/code-validator) | extension | 0.1.0 | Diagnostics tool for code validation | — |
| [dev-tools](addons/dev-tools) | extension | 0.1.0 | Developer tools for workspace diagnostics | — |
| [kanban-board-widget](addons/kanban-board-widget) | extension | 0.1.0 | Interactive kanban board widget | — |
| [delegate](addons/delegate) | extension | 0.1.0 | Delegate tasks to cheaper/faster models with auto model selection | delegate |

## Add-on Manifest Format

Each add-on is a directory under `addons/<slug>/` with a `package.json`:

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
    "tags": ["category"],
    "skills": ["skills/my-skill"]
  },
  "agents": {
    "skills": [
      { "name": "my-skill", "path": "./skills/my-skill" }
    ]
  }
}
```

### Dual manifest pattern

Add-ons can bundle **both** extensions and skills:

- **`piclaw`** field — piclaw-specific metadata: extension type, compatible versions, tags, and skill paths relative to the package root
- **`agents`** field — [agentskills.io](https://agentskills.io) compatible skill declarations, discoverable by `npx skills`, `npm-agentskills`, and 45+ coding agents

This means a piclaw add-on's skills are also installable by Claude Code, Cursor, Codex, Gemini CLI, etc. via:

```bash
npx skills add rcarmo/piclaw-addons --skill autoresearch-create
```

### Skill format

Skills follow the [Agent Skills standard](https://agentskills.io/specification):

```
skills/my-skill/
├── SKILL.md           # YAML frontmatter (name, description) + instructions
├── scripts/           # Optional executable helpers
└── references/        # Optional reference docs
```

### Extension entry point

The `main` field (default `index.ts`) must export an `ExtensionFactory`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "my-tool", ... });
}
```

## Catalog

The machine-readable catalog is at [`catalog.json`](catalog.json). The piclaw settings UI fetches it to show available add-ons with install/upgrade/remove buttons.

## Contributing

1. Create `addons/<your-slug>/`
2. Add `package.json` with the manifest fields above
3. Add `index.ts` exporting an `ExtensionFactory`
4. Optionally add `skills/<skill-name>/SKILL.md`
5. Update `catalog.json`
6. Open a PR

## License

MIT
