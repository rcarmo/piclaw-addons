# Developing piclaw add-ons

This guide covers how to create, test, and publish an extension for [piclaw](https://github.com/rcarmo/piclaw).

---

## Quick start

```bash
# 1. Create your addon directory
mkdir -p addons/my-addon/skills/my-skill

# 2. Write your entry point, package.json, and skill
# 3. Sync the catalog
bun run sync:catalog

# 4. Type-check
bunx tsc --noEmit

# 5. Push — CI handles the rest
git add addons/my-addon && git commit -m "feat: add my-addon" && git push
```

---

## Addon structure

> **Important:** standalone add-on packages must be self-contained.
> If an add-on is published as its own npm package (for example `@rcarmo/piclaw-addon-portainer`), it must not rely on repo-root files outside its package directory at runtime. Do not import `../../lib/compat/*` from a published standalone package unless those files are vendored into that package.

```
addons/<slug>/
├── index.ts          # Entry point (default export)
├── package.json      # Package manifest
├── skills/           # Optional: agent skills
│   └── my-skill/
│       └── SKILL.md
└── *.ts              # Supporting modules
```

---

## Entry point

The default export is a function that receives the `ExtensionAPI`:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function myAddon(pi: ExtensionAPI) {
  // Register skills for agent discovery
  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "skills", "my-skill", "SKILL.md")],
  }));

  // Register a tool
  pi.registerTool({
    name: "my_tool",
    label: "my_tool",
    description: "What this tool does.",
    parameters: MyToolSchema,
    async execute(_toolCallId, params, _signal, _update, ctx) {
      return { content: [{ type: "text", text: "result" }] };
    },
  });
}
```

---

## package.json

```json
{
  "name": "@rcarmo/piclaw-addon-<slug>",
  "version": "0.1.0",
  "description": "One-line description",
  "type": "module",
  "main": "index.ts",
  "piclaw": {
    "type": "extension",
    "tags": ["relevant", "tags"]
  },
  "pi": {
    "extensions": ["index.ts"],
    "skills": ["skills"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  },
  "publishConfig": {
    "registry": "https://npm.pkg.github.com",
    "access": "public"
  },
  "keywords": ["piclaw", "piclaw-addon"],
  "license": "MIT"
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | ✓ | `@rcarmo/piclaw-addon-<slug>` |
| `version` | ✓ | Bump on every functional change |
| `description` | ✓ | Shown in the catalog and web UI |
| `piclaw.type` | ✓ | `"extension"` or `"skill"` |
| `piclaw.tags` | ✓ | Categorisation for search and display |
| `pi.extensions` | ✓ | Entry points — usually `["index.ts"]` |
| `peerDependencies` | ✓ | Must declare both `@mariozechner/pi-coding-agent` and `@sinclair/typebox` |
| `publishConfig` | ✓ | Points to GitHub Packages registry |

---

## Skills

A skill teaches the agent *when and how* to use your tools:

```
addons/<slug>/skills/<skill-name>/SKILL.md
```

Front matter:
```yaml
---
name: my-skill
description: What this skill teaches the agent
distribution: public
---
```

Register skills via `resources_discover`:
```ts
pi.on("resources_discover", () => ({
  skillPaths: [join(baseDir, "skills", "my-skill", "SKILL.md")],
}));
```

---

## Extension API reference

| Capability | Method |
|---|---|
| Register tools | `pi.registerTool({ name, parameters, execute })` |
| Lifecycle hooks | `pi.on("before_agent_start", fn)` |
| Resource discovery | `pi.on("resources_discover", fn)` |
| Interactive UI | `ctx.ui.select()`, `.confirm()`, `.input()` |
| Progress | `ctx.ui.setWorkingMessage(text)` |
| Status | `ctx.ui.setStatus(key, text)` |
| Widgets | `ctx.ui.setWidget(key, content, options)` |
| Toasts | `ctx.ui.notify(message, type)` |

### Tool parameters

Use `@sinclair/typebox`:

```ts
import { Type } from "@sinclair/typebox";

const Params = Type.Object({
  action: Type.Union([Type.Literal("get"), Type.Literal("list")]),
  id: Type.Optional(Type.String()),
});
```

### KV storage

Persist config or state:

```ts
import { createExtensionStorage } from "../../lib/compat/extension-kv.js";

const kv = createExtensionStorage("my-addon");
kv.set("config", value, "chat", chatJid);   // per-chat
kv.set("prefs", value, "global");            // cross-chat
```

---

## Testing

### Standalone import test

```bash
bun test standalone-import.test.ts
```

Validates that each addon can be imported without crashing.

### Type-check

```bash
bunx tsc --noEmit
```

### Catalog validation

```bash
bun run check:catalog
```

---

## Publishing

### What happens on push

1. `sync-catalog` — regenerates `catalog.json` from all addon `package.json` files
2. `validate-metadata` — verifies the catalog is in sync and the package can be packed
3. `build + deploy` — rebuilds the docs site at [rcarmo.github.io/piclaw-addons](https://rcarmo.github.io/piclaw-addons/)
4. `publish` — publishes changed packages to GitHub Packages (`npm.pkg.github.com`)

### Manual sync

```bash
bun run sync:catalog    # regenerate
bun run check:catalog   # validate only (exits 1 if out of sync)
```

### After syncing

Add `owner` and `contributors` to your new entry in `catalog.json` — these fields are hand-managed and preserved by the sync script but cannot be generated automatically:

```json
"owner": { "login": "yourname", "url": "https://github.com/yourname" },
"contributors": []
```

---

## Conventions

- Slug: lowercase kebab-case (`proxmox`, `dev-tools`, `kanban-board-widget`)
- One extension entry point per addon
- Peer deps only — never bundle `@mariozechner/pi-coding-agent`
- Never import from piclaw runtime internals
- `lib/compat/` is for in-repo development only — published packages must vendor any shims they need
- Skills go in `skills/<name>/SKILL.md`
- Bump version for every functional change
- Run `sync:catalog` after every `package.json` edit
