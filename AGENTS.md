# piclaw-addons — Agent guide

Add-ons for [piclaw](https://github.com/rcarmo/piclaw) — extensions, skills, and widgets.

See [docs/architecture.md](docs/architecture.md) for the repo layout, catalog format, and CI/CD pipeline.

---

## How to add a new addon

> **Self-contained rule:** Each addon is published as its own npm package. It must not import from `../../lib/compat/*` at runtime — those paths don't exist in a consumer's `node_modules`. Either vendor the compat shims you need into the addon directory, or use the equivalent piclaw runtime imports (with a compat stub for standalone use).

### 1. Create the directory

```
addons/<slug>/
├── index.ts          # Required: default export = extension factory
├── package.json      # Required: addon manifest
└── skills/           # Optional: colocated skills (SKILL.md per skill)
```

### 2. Write the entry point

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function myAddon(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "skills", "my-skill", "SKILL.md")],
  }));

  pi.registerTool({
    name: "my_tool",
    label: "my_tool",
    description: "What this tool does.",
    parameters: MyToolSchema,  // Typebox schema
    async execute(_toolCallId, params, _signal, _update, ctx) {
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
  "name": "@rcarmo/piclaw-addon-<slug>",
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
  "publishConfig": {
    "registry": "https://npm.pkg.github.com",
    "access": "public"
  },
  "license": "MIT",
  "keywords": ["piclaw", "piclaw-addon"],
  "pi": {
    "extensions": ["index.ts"],
    "skills": ["skills"]
  }
}
```

Key fields:

| Field | Purpose |
|---|---|
| `name` | Scoped package name: `@rcarmo/piclaw-addon-<slug>` |
| `piclaw.type` | Always `"extension"` (or `"skill"` for skill-only addons) |
| `piclaw.tags` | Categorisation tags used by the catalog |
| `pi.extensions` | Entry points declared for the Pi package system |
| `pi.skills` | Skill roots for discovery |
| `peerDependencies` | Must declare `@mariozechner/pi-coding-agent` and `@sinclair/typebox` |
| `publishConfig.registry` | GitHub Packages — required for scoped publish |

### 4. Sync the catalog

```bash
bun run sync:catalog    # regenerate catalog.json + root package.json
bun run check:catalog   # validate without writing (CI uses this)
```

After syncing, also add `owner` / `contributors` to the new entry in `catalog.json` — the sync script preserves these when they exist but cannot generate them from source.

### 5. Type-check

```bash
bunx tsc --noEmit
```

---

## Extension API

### What extensions can do

| Capability | API |
|---|---|
| Register tools | `pi.registerTool({ name, parameters, execute })` |
| Hook lifecycle | `pi.on("before_agent_start", ...)` |
| Discover resources | `pi.on("resources_discover", ...)` — skills, prompts, themes |
| Interactive UI | `ctx.ui.select()`, `.confirm()`, `.input()` |
| Progress | `ctx.ui.setWorkingMessage()`, `.setWorkingIndicator()` |
| Persistent status | `ctx.ui.setStatus(key, text)` |
| Dashboard widgets | `ctx.ui.setWidget(key, content, options)` |
| Toast notifications | `ctx.ui.notify(message, type)` |

### KV storage

```ts
import { createExtensionStorage } from "../../lib/compat/extension-kv.js";

const storage = createExtensionStorage("my-addon");

// Chat-scoped
storage.set("config", { base_url: "..." }, "chat", chatJid);
const config = storage.get("config", "chat", chatJid);

// Global
storage.set("preferences", { ... }, "global");
```

Backed by SQLite in piclaw; falls back to in-memory Map in tests.

### Compat layer (`lib/compat/`)

Use these shims instead of importing piclaw internals directly:

| Shim | Exports |
|---|---|
| `keychain.ts` | `getKeychainEntry`, `resolveKeychainPlaceholders`, `buildInjectedExecCommand` |
| `chat-context.ts` | `getChatJid`, `getChatChannel` |
| `extension-kv.ts` | `createExtensionStorage`, `ExtensionStorage` |
| `logger.ts` | `createLogger`, `debugSuppressedError` |
| `tool-output.ts` | `saveToolOutput`, `buildPreview` |
| `tool-status-hints.ts` | `registerToolStatusHintProvider` |
| `request-batch.ts` | `runRequestBatch`, `writeRequestOutputFile` |
| `structured-tool-response.ts` | `presentStructuredToolValue` |
| `types.ts` | `ProxmoxConfig`, `PortainerConfig`, shared config types |
| `config.ts` | `WORKSPACE_DIR` |

```ts
import { getChatJid, createLogger, createExtensionStorage } from "../../lib/compat/index.js";
```

> These are in-repo dev paths. Published addons must vendor any shims they need.

### Tool parameter schemas

```ts
import { Type } from "@sinclair/typebox";

const MyToolSchema = Type.Object({
  action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
  key: Type.Optional(Type.String()),
});
```

### Skills

```
addons/<slug>/skills/<skill-name>/SKILL.md
```

Front matter:
```yaml
---
name: my-skill
description: What this skill teaches the agent to do
distribution: public
---
```

Register in `resources_discover`:
```ts
pi.on("resources_discover", () => ({
  skillPaths: [join(baseDir, "skills", "my-skill", "SKILL.md")],
}));
```

---

## Conventions

- Slug: lowercase kebab-case — `proxmox`, `dev-tools`, `kanban-board-widget`
- Package name: `@rcarmo/piclaw-addon-<slug>`
- One extension entry point per addon
- Peer deps only — no bundled copies of `@mariozechner/pi-coding-agent`
- Never import from piclaw runtime internals — use `lib/compat/`
- Run `bun run sync:catalog` after any `package.json` change
- Bump `version` for every functional change
- Skills in `skills/<name>/SKILL.md` inside the addon directory
- Add `owner` to `catalog.json` after syncing

---

## Current addons

| Slug | Description | Version | Owner |
|---|---|---|---|
| `autoresearch` | Autonomous experiment loop sub-agent | 0.1.0 | rcarmo |
| `cheapskate` | Free-tier provider auto-rotation | 0.4.0 | rcarmo |
| `code-validator` | Code validation for Python, JS/TS, JSON | 0.1.0 | cjnova |
| `delegate` | Task delegation to cheaper/faster models | 0.1.0 | cjnova |
| `dev-tools` | Workspace diagnostics and environment tools | 0.1.0 | rcarmo |
| `drawio-editor` | Self-hosted draw.io diagram editor | 0.1.0 | rcarmo |
| `eml-viewer` | Email (.eml) viewer for the web timeline | 0.2.1 | rcarmo |
| `imap` | IMAP email management with drafts and STARTTLS | 0.1.0 | rcarmo |
| `kanban-board-widget` | Kanban board dashboard widget | 0.1.0 | cjnova |
| `portainer` | Portainer container management | 0.1.2 | rcarmo |
| `proxmox` | Proxmox VE infrastructure management | 0.1.3 | rcarmo |
| `voice-pipeline` | ESPHome voice assistant for ThinkSmart/ESP32 | 0.1.0 | rcarmo |
| `yolochat` | Zero-guardrail inter-instance messaging | 0.1.0 | rcarmo |
