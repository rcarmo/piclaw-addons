# piclaw-addons

Community add-ons for [piclaw](https://github.com/rcarmo/piclaw).

This repository is a monorepo of piclaw add-ons. Each addon under `addons/` is an independent npm package published to [GitHub Packages](https://github.com/rcarmo?tab=packages&repo_name=piclaw-addons).

> **For agents:** see [AGENTS.md](AGENTS.md) for how to add, modify, and test addons.

## Installing add-ons

### From the piclaw web UI

Open **Settings → Add-ons**, pick the addon you want, and click **Install**. The runtime fetches the package from GitHub Packages and installs it automatically. A restart is required to load the new extension.

### From the command line

Each addon is published as a scoped npm package on the GitHub Packages registry. To install with plain `bun`:

```bash
# One-time setup: configure the @rcarmo scope to use GitHub Packages
cd /workspace/.piclaw/addons
echo '@rcarmo:registry=https://npm.pkg.github.com' >> .npmrc
echo '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}' >> .npmrc

# Install an addon
bun add @rcarmo/piclaw-addon-proxmox
```

Replace `GITHUB_TOKEN` with any GitHub token that has `read:packages` scope (a classic PAT or fine-grained token works). The `.npmrc` file uses environment variable interpolation, so the token is never stored in plain text.

### Using `pi install`

If you prefer the [Pi CLI](https://github.com/nicepkg/pi), addons can be installed directly:

```bash
pi install npm:@rcarmo/piclaw-addon-proxmox@0.1.3
```

This writes the package to your Pi settings (`~/.pi/agent/settings.json` by default, or `.pi/settings.json` with `-l`).

### All available packages

| Package | Install command |
|---|---|
| `@rcarmo/piclaw-addon-autoresearch` | `bun add @rcarmo/piclaw-addon-autoresearch` |
| `@rcarmo/piclaw-addon-cheapskate` | `bun add @rcarmo/piclaw-addon-cheapskate` |
| `@rcarmo/piclaw-addon-code-validator` | `bun add @rcarmo/piclaw-addon-code-validator` |
| `@rcarmo/piclaw-addon-delegate` | `bun add @rcarmo/piclaw-addon-delegate` |
| `@rcarmo/piclaw-addon-dev-tools` | `bun add @rcarmo/piclaw-addon-dev-tools` |
| `@rcarmo/piclaw-addon-drawio-editor` | `bun add @rcarmo/piclaw-addon-drawio-editor` |
| `@rcarmo/piclaw-addon-eml-viewer` | `bun add @rcarmo/piclaw-addon-eml-viewer` |
| `@rcarmo/piclaw-addon-imap` | `bun add @rcarmo/piclaw-addon-imap` |
| `@rcarmo/piclaw-addon-kanban-board-widget` | `bun add @rcarmo/piclaw-addon-kanban-board-widget` |
| `@rcarmo/piclaw-addon-portainer` | `bun add @rcarmo/piclaw-addon-portainer` |
| `@rcarmo/piclaw-addon-proxmox` | `bun add @rcarmo/piclaw-addon-proxmox` |
| `@rcarmo/piclaw-addon-voice-pipeline` | `bun add @rcarmo/piclaw-addon-voice-pipeline` |
| `@rcarmo/piclaw-addon-yolochat` | `bun add @rcarmo/piclaw-addon-yolochat` |

## Available addons

| Addon | Description | Version |
|---|---|---|
| [`autoresearch`](addons/autoresearch/) | Autonomous experiment loop sub-agent (start/stop/status tools via tmux) | 0.1.0 |
| [`cheapskate`](addons/cheapskate/) | Free-tier provider auto-rotation (`cheapskate/auto` model) | 0.4.0 |
| [`code-validator`](addons/code-validator/) | Diagnostics tool for code validation (Python, JS/TS, JSON, extensible) | 0.1.0 |
| [`delegate`](addons/delegate/) | Task delegation to cheaper/faster models with tool access | 0.1.0 |
| [`dev-tools`](addons/dev-tools/) | Developer utility tools for workspace diagnostics | 0.1.0 |
| [`drawio-editor`](addons/drawio-editor/) | Self-hosted draw.io diagram editor with workspace integration | 0.1.0 |
| [`eml-viewer`](addons/eml-viewer/) | Email (.eml) file viewer for the web timeline | 0.2.1 |
| [`imap`](addons/imap/) | IMAP email management with drafts, filing, and STARTTLS | 0.1.0 |
| [`kanban-board-widget`](addons/kanban-board-widget/) | Interactive kanban board dashboard widget | 0.1.0 |
| [`portainer`](addons/portainer/) | Portainer container management tool | 0.1.2 |
| [`proxmox`](addons/proxmox/) | Proxmox VE infrastructure management tool | 0.1.3 |
| [`voice-pipeline`](addons/voice-pipeline/) | ESPHome voice assistant pipeline for ThinkSmart/ESP32-Audio | 0.1.0 |
| [`yolochat`](addons/yolochat/) | Zero-guardrail inter-instance messaging between Pi instances | 0.1.0 |

## Architecture


![Installation architecture](assets/install-architecture.svg)
```

### Catalog

`catalog.json` is the central index consumed by the piclaw web UI. It is auto-generated from addon `package.json` files by the `sync-catalog` workflow.

Each entry contains:

```json
{
  "slug": "proxmox",
  "name": "@rcarmo/piclaw-addon-proxmox",
  "version": "0.1.3",
  "install": {
    "kind": "npm",
    "spec": "@rcarmo/piclaw-addon-proxmox@0.1.3",
    "registry": "https://npm.pkg.github.com",
    "piSource": "npm:@rcarmo/piclaw-addon-proxmox@0.1.3"
  }
}
```

| Field | Purpose |
|---|---|
| `install.spec` | Passed to `bun add` — scoped package name with version |
| `install.registry` | GitHub Packages npm registry URL |
| `install.piSource` | Used by `pi install` for Pi CLI users |

### GitHub Packages authentication

GitHub Packages npm registry requires authentication even for reads. The piclaw runtime automatically configures `.npmrc` in the addons directory with:

```ini
@rcarmo:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PICLAW_BOT_PAT}
```

The token is injected from the keychain as an environment variable. Any GitHub token with `read:packages` scope is sufficient.

### Fallback mechanism

If `bun add` fails (e.g. no token configured, network issue), the install handler falls back to downloading individual files from the GitHub repository via the GitHub API. This is slower but requires no npm registry authentication.

## Publishing workflow

![Event sequence](assets/event-sequence.svg)

When an addon is updated, the chain runs automatically:

1. **`git push addons/<slug>`** triggers **`sync-catalog`** → rewrites `catalog.json`
2. **`catalog.json` commit** triggers **`build + deploy`** → rebuilds the docs site and pushes to `gh-pages`
3. **GitHub Actions** publishes updated packages to **GitHub Packages** npm registry
4. Site at [rcarmo.github.io/piclaw-addons](https://rcarmo.github.io/piclaw-addons/) goes live ~30s later

`workflow_dispatch` on `build.yml` bypasses the chain and deploys directly.

## Creating a new addon

Each addon is a standalone npm package with:

```json
{
  "name": "@rcarmo/piclaw-addon-<slug>",
  "version": "0.1.0",
  "pi": {
    "extensions": ["index.ts"],
    "skills": ["skills"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  }
}
```

Place it under `addons/<slug>/`, push to `main`, and the CI pipeline handles the rest.

## Layout

```text
piclaw-addons/
├── addons/
│   ├── autoresearch/
│   ├── cheapskate/
│   ├── code-validator/
│   ├── delegate/
│   ├── dev-tools/
│   ├── drawio-editor/
│   ├── eml-viewer/
│   ├── imap/
│   ├── kanban-board-widget/
│   ├── portainer/
│   ├── proxmox/
│   ├── voice-pipeline/
│   └── yolochat/
├── lib/
│   └── compat/           # Shared compatibility shims
├── catalog.json           # Auto-generated addon index
├── package.json           # Root package manifest
├── tsconfig.json
├── scripts/
│   ├── browser-relay/     # WSL2 browser relay utility
│   └── sync-catalog.ts    # Catalog + metadata generator
└── .github/
    └── workflows/
        ├── build.yml              # Docs site + GitHub Pages deploy
        ├── sync-catalog.yml       # Catalog auto-regeneration
        ├── validate-metadata.yml  # PR/push metadata validation
        └── triage-issues.yml      # Issue triage automation
```

## Metadata sync

The addon catalog and root package metadata are generated from the addon `package.json` files:

```bash
bun run check:catalog   # validate metadata is in sync
bun run sync:catalog    # regenerate catalog.json + root package metadata
```

`sync-catalog.ts` derives:

- Root `pi.extensions` and `pi.skills`
- Root `agents.skills`
- `catalog.json` (including per-addon install specs)

from each `addons/<slug>/package.json`.

## Utility scripts

- [`scripts/browser-relay/`](scripts/browser-relay/README.md) — WSL2 browser relay for opening container-launched OAuth and local UI URLs in the Windows browser
