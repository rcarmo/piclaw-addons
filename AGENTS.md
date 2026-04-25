# piclaw-addons

Add-ons for [piclaw](https://github.com/rcarmo/piclaw) — extensions, skills, and widgets.

## Repository layout

```
piclaw-addons/
├── addons/                         # One directory per addon
│   ├── autoresearch/
│   │   ├── index.ts                # Extension entry point (default export)
│   │   ├── package.json            # Addon manifest
│   │   ├── skills/                 # Colocated skills
│   │   │   └── autoresearch-create/
│   │   │       └── SKILL.md
│   │   └── *.ts                    # Implementation files
│   ├── proxmox/
│   ├── portainer/
│   └── ...
├── lib/
│   └── compat/                     # Shared compatibility shims (not an addon)
│       ├── index.ts                # Re-exports all shims
│       ├── keychain.ts             # Keychain/token access
│       ├── chat-context.ts         # Chat JID via AsyncLocalStorage
│       ├── extension-kv.ts         # Scoped KV store client
│       ├── logger.ts               # Console-based logger
│       ├── tool-output.ts          # Large output → file store
│       ├── request-batch.ts        # Retry/throttle batch runner
│       ├── structured-tool-response.ts
│       ├── tool-status-hints.ts    # Web UI hint registry
│       ├── types.ts                # Shared type interfaces
│       └── config.ts               # WORKSPACE_DIR
├── scripts/
│   └── sync-catalog.ts             # Catalog and root metadata sync
├── catalog.json                    # Generated addon catalog
├── package.json                    # Root Pi package manifest
└── tsconfig.json
```

## How to add a new addon

### 1. Create the directory

```
addons/<slug>/
├── index.ts          # Required: default export = extension factory
├── package.json      # Required: addon manifest
└── skills/           # Optional: colocated skills with SKILL.md files
```

### 2. Write the entry point

The default export must be a function that receives `ExtensionAPI` from `@mariozechner/pi-coding-agent`:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function myAddon(pi: ExtensionAPI) {
  // Register event hooks
  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "skills", "my-skill", "SKILL.md")],
  }));

  // Register tools
  pi.registerTool({
    name: "my_tool",
    label: "my_tool",
    description: "What this tool does.",
    parameters: MyToolSchema,  // Typebox schema
    async execute(_toolCallId, params, _signal, _update, ctx) {
      // Tool implementation
      return {
        content: [{ type: "text", text: "Result" }],
        details: { ... },
      };
    },
  });
}
```

### 3. Write the package.json

```json
{
  "name": "piclaw-addon-<slug>",
  "version": "0.1.0",
  "description": "Short description of the addon",
  "type": "module",
  "main": "index.ts",
  "piclaw": {
    "type": "extension",
    "compatibleVersions": ">=1.8.0",
    "tags": ["relevant", "tags"],
    "skills": ["skills/my-skill"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  },
  "license": "MIT",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["index.ts"],
    "skills": ["skills"]
  }
}
```

Key fields:

| Field | Purpose |
|---|---|
| `name` | npm package name, convention: `piclaw-addon-<slug>` |
| `main` | Entry point (default: `index.ts`) |
| `piclaw.type` | Always `"extension"` |
| `piclaw.compatibleVersions` | Semver range for piclaw compatibility |
| `piclaw.tags` | Categorization tags |
| `piclaw.skills` | Relative paths to skill directories |
| `pi.extensions` | Entry points for the Pi package system |
| `pi.skills` | Skill roots for Pi package discovery |
| `peerDependencies` | Must include `@mariozechner/pi-coding-agent` and `@sinclair/typebox` |
| `keywords` | Must include `"pi-package"` |

### 4. Sync the catalog

After adding or modifying an addon, run:

```bash
bun run sync:catalog
```

This regenerates:
- `catalog.json` — the addon catalog with install specs
- Root `package.json` — the `pi.extensions`, `pi.skills`, and `agents.skills` fields

To validate without writing:

```bash
bun run check:catalog
```

CI runs `check:catalog` on every push and PR.

### 5. Type-check

```bash
bunx tsc --noEmit
```

Addon code should produce zero TypeScript errors. Pre-existing errors in other addons are tracked separately.

## Catalog mechanism

### What `catalog.json` contains

An array of addon entries, each derived from the addon's `package.json`:

```json
{
  "slug": "proxmox",
  "name": "piclaw-addon-proxmox",
  "version": "0.1.2",
  "type": "extension",
  "description": "Proxmox VE management tool ...",
  "path": "addons/proxmox",
  "tags": ["proxmox", "infrastructure"],
  "skills": ["proxmox-guest-compare-chart"],
  "install": {
    "kind": "npm",
    "spec": "piclaw-addon-proxmox@0.1.2",
    "piSource": "npm:piclaw-addon-proxmox@0.1.2"
  }
}
```

### How sync works

`scripts/sync-catalog.ts` scans every `addons/<slug>/package.json` and:

1. Builds catalog entries from `piclaw.*` and `pi.*` fields
2. Aggregates root `pi.extensions` — all addon entry points
3. Aggregates root `pi.skills` — all addon skill roots
4. Aggregates root `agents.skills` — named skill entries for agent discovery
5. Writes `catalog.json` and updates root `package.json`

### What the root package.json does

The root package is a Pi package itself (`keywords: ["pi-package"]`). When installed, all addon extensions and skills are registered automatically via the `pi.*` manifest fields.

## Extension integration points

### What extensions can do

| Capability | API | Notes |
|---|---|---|
| Register tools | `pi.registerTool({ name, parameters, execute })` | Tool appears in agent tool list |
| Hook lifecycle events | `pi.on("before_agent_start", ...)` | Inject system prompt, modify context |
| Discover resources | `pi.on("resources_discover", ...)` | Register skills, prompts, themes |
| Show UI (interactive) | `ctx.ui.select()`, `confirm()`, `input()` | SSE-based dialogs in web UI |
| Show progress | `ctx.ui.setWorkingMessage()`, `setWorkingIndicator()` | Transient per-turn status |
| Show status | `ctx.ui.setStatus(key, text)` | Secondary status text |
| Manage widgets | `ctx.ui.setWidget(key, content, options)` | Durable status panels |
| Toast notifications | `ctx.ui.notify(message, type)` | Ephemeral alerts |

### Persistence via extension KV store

Extensions can persist config and state through the scoped KV store:

```ts
import { createExtensionStorage } from "../../lib/compat/extension-kv.js";

const storage = createExtensionStorage("my-addon");

// Chat-scoped (per chat session)
storage.set("config", { base_url: "..." }, "chat", chatJid);
const config = storage.get("config", "chat", chatJid);
storage.delete("config", "chat", chatJid);

// Global (cross-session)
storage.set("preferences", { ... }, "global");
const prefs = storage.get("preferences", "global");

// List keys
const keys = storage.list("config", "chat", chatJid);
storage.clear("chat", chatJid);
```

When running inside piclaw, the KV store is backed by SQLite (`extension_kv` table). When running standalone (e.g., tests), it falls back to an in-memory Map.

### Shared compat layer (`lib/compat/`)

Addons should NOT import from piclaw internals. Use the compat layer instead:

| Shim | What it replaces | Import |
|---|---|---|
| `keychain.ts` | `secure/keychain.ts` | `getKeychainEntry`, `resolveKeychainPlaceholders`, `buildInjectedExecCommand` |
| `chat-context.ts` | `core/chat-context.ts` | `getChatJid`, `getChatChannel` |
| `extension-kv.ts` | `db/extension-kv.ts` | `createExtensionStorage`, `ExtensionStorage` |
| `logger.ts` | `utils/logger.ts` | `createLogger`, `debugSuppressedError` |
| `tool-output.ts` | `tool-output.ts` | `saveToolOutput`, `buildPreview` |
| `tool-status-hints.ts` | `tool-status-hints.ts` | `registerToolStatusHintProvider` |
| `request-batch.ts` | `extensions/request-batch.ts` | `runRequestBatch`, `writeRequestOutputFile` |
| `structured-tool-response.ts` | `extensions/structured-tool-response.ts` | `presentStructuredToolValue` |
| `types.ts` | `types.ts` | `ProxmoxConfig`, `PortainerConfig`, etc. |
| `config.ts` | `core/config.ts` | `WORKSPACE_DIR` |

Import from the compat layer:

```ts
import { getChatJid, createLogger, createExtensionStorage } from "../../lib/compat/index.js";
```

### Tool parameter schemas

Use `@sinclair/typebox` for tool parameter schemas:

```ts
import { Type } from "@sinclair/typebox";

const MyToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("get"),
    Type.Literal("set"),
    Type.Literal("clear"),
  ]),
  key: Type.Optional(Type.String()),
  value: Type.Optional(Type.Unknown()),
});
```

### Skills

Skills are markdown files that teach the agent how to use the addon:

```
addons/<slug>/skills/<skill-name>/SKILL.md
```

The SKILL.md front matter:

```yaml
---
name: my-skill
description: What this skill teaches the agent to do
distribution: public
---
```

Register skills in `resources_discover`:

```ts
pi.on("resources_discover", () => ({
  skillPaths: [join(baseDir, "skills", "my-skill", "SKILL.md")],
}));
```

## Conventions

- Addon slugs are lowercase kebab-case: `proxmox`, `dev-tools`, `kanban-board-widget`
- Package names follow `piclaw-addon-<slug>`
- One extension per addon directory
- Peer dependencies only — no bundled copies of `@mariozechner/pi-coding-agent`
- Use the compat layer — never import from piclaw runtime internals
- Type-check clean before committing
- Run `bun run sync:catalog` after any manifest change
- Bump the addon `version` field for any functional change
- Skills go in `skills/<skill-name>/SKILL.md` inside the addon directory

## CI

- `validate-metadata.yml` — runs `check:catalog` + `bun pm pack --dry-run` on every push/PR
- `sync-catalog.yml` — auto-syncs catalog on main (if configured)

## Existing addons

| Addon | Description | Version |
|---|---|---|
| `autoresearch` | Autonomous experiment loop sub-agent | 0.1.0 |
| `code-validator` | Code validation tools | 0.1.0 |
| `delegate` | Task delegation to sub-agents | 0.1.0 |
| `dev-tools` | Developer utility tools | 0.1.0 |
| `drawio-editor` | draw.io diagram editor widget | 0.1.0 |
| `eml-viewer` | Email (.eml) file viewer | 0.1.0 |
| `kanban-board-widget` | Kanban board timeline widget | 0.1.0 |
| `portainer` | Portainer container management | 0.1.1 |
| `proxmox` | Proxmox VE infrastructure management | 0.1.2 |
