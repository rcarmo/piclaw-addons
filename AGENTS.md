# Developing piclaw add-ons

This guide covers how to create, test, and publish an extension for [piclaw](https://github.com/rcarmo/piclaw).

---

## Quick start

> **Install-path rule:** first-party `piclaw-addons` must install via **public GitHub-hosted tarball URLs** from `catalog.json`.
> Do **not** change docs, generated catalog entries, or runtime integration back to npmjs.org package specs or authenticated GitHub Packages reads.
> Runtime install/remove must remain zero-auth.


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
├── index.ts          # Runtime entry point (default export)
├── web/
│   └── index.ts      # Optional browser-side settings pane / web entry
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
    "web": {
      "entries": ["web/index.ts"]
    },
    "skills": ["skills"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
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

### Settings panes and direct config API

For add-ons that expose a **Settings** pane:

#### Runtime side

Register config handlers directly from the runtime entry using the global registrar exposed by piclaw:

```ts
const registerAddonConfigApi = globalThis.__piclaw_registerAddonConfigApi;

registerAddonConfigApi?.("my-addon", "config", {
  get: async () => loadConfig(),
  set: async (payload) => {
    const next = saveConfig(payload);
    return { ok: true, config: next };
  },
}, import.meta.dir);
```

#### Browser side

Use the browser globals provided by piclaw and fetch the authenticated local config API:

```ts
const API = "/agent/addons/api/my-addon";
const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact;

await fetch(`${API}/config`);
await fetch(`${API}/config`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ enabled: true }),
});
```

Use `/agent/keychain` only for secrets. Do **not** build new settings panes around internal slash commands.

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

### UI screenshot workflow (recommended)

For add-ons with a settings pane or other meaningful web UI, contributors should capture a screenshot from the **microVM test instance** and commit it alongside the add-on docs.

Recommended flow:

1. deploy/test on the microVM using the `microvm-ui-test` skill
2. capture the UI with the shared script:
   ```bash
   cd /workspace/piclaw-addons
   PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright \
     bun run scripts/capture-addon-settings-screenshot.ts \
     --url http://192.168.1.78:8080 \
     --pane "<Pane Label>" \
     --out addons/<slug>/assets/settings-pane-microvm.png
   ```
3. reference the screenshot from `addons/<slug>/README.md`
4. prefer at least one screenshot for settings-pane add-ons; for non-UI add-ons, screenshots are optional

Store screenshots under `addons/<slug>/assets/` when possible so the README can reference them with a stable relative path.

---

## Publishing

### What happens on push

1. `sync-catalog` — regenerates `catalog.json` from all addon `package.json` files using **public GitHub Pages tarball URLs**
2. `validate-metadata` — verifies the catalog is in sync and the package can be packed
3. `build + deploy` — rebuilds the docs site at [rcarmo.github.io/piclaw-addons](https://rcarmo.github.io/piclaw-addons/) and publishes the downloadable `.tgz` files

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
- Browser-side settings panes must use the **direct backend add-on config API** (`/agent/addons/api/<addon>/<action>`) and secrets should still go through `/agent/keychain`
- Runtime-side settings/config handlers should register via `globalThis.__piclaw_registerAddonConfigApi(...)` at module load time so the web pane does not depend on slash commands
- Slash-command config bridges are legacy fallback only; do not add new settings-pane code that relies on `/addon-config-get` / `/addon-config-set`
- Settings-pane add-ons should include at least one committed README screenshot captured from the microVM test instance when the UI meaningfully changes
- Skills go in `skills/<name>/SKILL.md`
- Bump version for every functional change
- Run `sync:catalog` after every `package.json` edit
- Catalog install entries for first-party add-ons must stay `kind: "tarball"` with public `https://rcarmo.github.io/piclaw-addons/packages/...tgz` URLs

## Git workflow

- **Always use pull requests** — never commit directly to `main`
- Create a feature branch, commit, push, and open a PR via `gh pr create`
- Wait for the user to approve or say "merge" before merging
- Use `gh pr merge --merge --delete-branch` to merge and clean up
- PR descriptions should include: summary, what changed, test results
- One logical change per PR; don't bundle unrelated work

### Worktrees

- Use `git worktree add` for parallel work instead of switching branches in the main checkout
- After merging a PR, remove the worktree (`git worktree remove <path>`) and confirm cleanup with `git worktree list`
- Before starting new work, run `git worktree list` and prune any stale/orphaned worktrees (`git worktree prune`)
- Never leave merged-branch worktrees lying around
