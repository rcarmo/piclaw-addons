# piclaw-addons

Community add-ons for [piclaw](https://github.com/rcarmo/piclaw) — extensions, skills, and widgets.

Compatible with the [Pi Packages](https://pi.dev/packages) ecosystem.

## Install

### Via pi (recommended)

```bash
# Install the entire package (all extensions + skills)
pi install git:github.com/rcarmo/piclaw-addons

# Or install globally
pi install -g git:github.com/rcarmo/piclaw-addons
```

### Via piclaw Settings UI

Open Settings → Add-ons → click **Install** on any add-on.

### Individual add-ons

Each addon under `addons/<slug>/` is also a standalone pi package:

```bash
pi install git:github.com/rcarmo/piclaw-addons -e extensions/code-validator.ts
```

## Available Add-ons

| Add-on | Type | Description | Skills |
|--------|------|-------------|--------|
| [autoresearch](addons/autoresearch) | extension + skill | Autonomous experiment loop sub-agent | autoresearch-create |
| [code-validator](addons/code-validator) | extension | Code validation (Python, JS/TS, JSON) | — |
| [delegate](addons/delegate) | extension + skill | Task delegation to sub-agents | delegate |
| [dev-tools](addons/dev-tools) | extension | Developer tools for workspace diagnostics | — |
| [drawio-editor](addons/drawio-editor) | extension | Self-hosted draw.io diagram editor | — |
| [eml-viewer](addons/eml-viewer) | extension | Email message (.eml) file previewer | — |
| [kanban-board-widget](addons/kanban-board-widget) | extension | Interactive kanban board widget | — |

## Package Structure

This repo is a **pi package** — it follows the [Pi Packages](https://pi.dev/packages) spec:

```
piclaw-addons/
├── package.json          # Pi package manifest (pi.extensions, pi.skills)
├── catalog.json          # Machine-readable addon catalog for the settings UI
├── extensions/           # Re-export wrappers for each addon
│   ├── autoresearch.ts
│   ├── code-validator.ts
│   └── ...
├── skills/               # Aggregated skills from all addons
│   ├── autoresearch-create/SKILL.md
│   └── delegate/SKILL.md
└── addons/               # Individual addon source directories
    ├── autoresearch/
    │   ├── package.json  # Also a standalone pi package
    │   ├── index.ts      # ExtensionFactory entry point
    │   └── skills/       # Addon-specific skills
    ├── code-validator/
    └── ...
```

### Dual compatibility

- **`pi` field** in `package.json` → compatible with `pi install` and the [Pi Package Gallery](https://pi.dev/packages)
- **`agents` field** → compatible with [agentskills.io](https://agentskills.io), `npx skills`, and 45+ coding agents
- **`piclaw` field** → piclaw-specific metadata (type, tags, compatibleVersions)
- **`catalog.json`** → machine-readable index used by the piclaw settings UI

### Creating an add-on

1. Create `addons/<your-slug>/`
2. Add `package.json` with `keywords: ["pi-package"]` and `pi.extensions`
3. Add `index.ts` exporting an `ExtensionFactory`
4. Optionally add `skills/<skill-name>/SKILL.md`
5. Add a re-export in `extensions/<your-slug>.ts`
6. Copy skills to `skills/` root
7. Update `catalog.json`
8. Open a PR

## License

MIT
