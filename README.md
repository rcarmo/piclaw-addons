# piclaw-addons

Community add-ons for [piclaw](https://github.com/rcarmo/piclaw).

This repository is structured as a **Pi package** and is intended to be compatible with the [Pi Packages gallery](https://pi.dev/packages).

> **For agents:** see [AGENTS.md](AGENTS.md) for how to add, modify, and test addons.

## Available addons

| Addon | Description | Version |
|---|---|---|
| [`autoresearch`](addons/autoresearch/) | Autonomous experiment loop sub-agent | 0.1.0 |
| [`cheapskate`](addons/cheapskate/) | Free-tier provider auto-rotation (`cheapskate/auto` model) | 0.2.0 |
| [`code-validator`](addons/code-validator/) | Code validation tools | 0.1.0 |
| [`delegate`](addons/delegate/) | Task delegation to sub-agents | 0.1.0 |
| [`dev-tools`](addons/dev-tools/) | Developer utility tools | 0.1.0 |
| [`drawio-editor`](addons/drawio-editor/) | draw.io diagram editor widget | 0.1.0 |
| [`eml-viewer`](addons/eml-viewer/) | Email (.eml) file viewer | 0.1.0 |
| [`kanban-board-widget`](addons/kanban-board-widget/) | Kanban board timeline widget | 0.1.0 |
| [`portainer`](addons/portainer/) | Portainer container management tool | 0.1.2 |
| [`proxmox`](addons/proxmox/) | Proxmox VE infrastructure management tool | 0.1.3 |

## What this repo provides

- **Root package**: `piclaw-addons`
- **Pi package manifest**: root `package.json` with `keywords: ["pi-package"]` and `pi.*` entries
- **Addon manifests**: each `addons/<slug>/package.json` is also Pi-package-shaped
- **Catalog**: `catalog.json` for the piclaw web settings UI
- **Shared compat layer**: `lib/compat/` — standalone shims for keychain, logging, KV storage, etc. (repo-level reference code; individually published add-ons still need their own self-contained copies)

## Layout

```text
piclaw-addons/
├── addons/
│   ├── autoresearch/
│   ├── code-validator/
│   ├── delegate/
│   ├── dev-tools/
│   ├── drawio-editor/
│   ├── eml-viewer/
│   ├── kanban-board-widget/
│   ├── portainer/
│   └── proxmox/
├── lib/
│   └── compat/           # Shared compatibility shims
├── catalog.json
├── package.json
├── tsconfig.json
└── scripts/
    ├── browser-relay/
    └── sync-catalog.ts
```

The root package points directly at addon entrypoints under `addons/*`.
No duplicate wrapper extensions or copied skill directories are needed.

## Metadata sync

The addon catalog and root package metadata are generated from the addon manifests.
The catalog also emits per-addon package install specs so piclaw Settings can do package-first installs (`bun add <spec>`) instead of downloading raw files.

```bash
bun run check:catalog   # validate metadata is in sync
bun run sync:catalog    # regenerate catalog.json + root package metadata
```

`sync-catalog.ts` derives:

- root `pi.extensions`
- root `pi.skills`
- root `agents.skills`
- `catalog.json` (including per-addon `install.kind/spec/piSource`)

from each `addons/<slug>/package.json`.

## Utility scripts

The `scripts/` directory also contains non-package helper tooling for common PiClaw setups.
These scripts are repository utilities, not published addon entrypoints, so they do not affect the generated package metadata.

- [`scripts/browser-relay/`](scripts/browser-relay/README.md) — WSL2 browser relay for opening container-launched OAuth and local UI URLs in the Windows browser

## GitHub Actions

This repo includes workflows to:

- **validate** metadata on pull requests and pushes
- **auto-sync** `catalog.json` and root package metadata on `main`

## Publishing

This repo is now **Pi-package compliant**.
To appear on the public Pi package gallery, the root package still needs to be published to npm with the `pi-package` keyword.

At that point installation can use:

```bash
pi install npm:piclaw-addons
```

Until then, the package structure is ready and local/path installs work.
