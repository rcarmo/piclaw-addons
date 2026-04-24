# piclaw-addons

Community add-ons for [piclaw](https://github.com/rcarmo/piclaw).

This repository is structured as a **Pi package** and is intended to be compatible with the [Pi Packages gallery](https://pi.dev/packages).

## What this repo provides

- **Root package**: `piclaw-addons`
- **Pi package manifest**: root `package.json` with `keywords: ["pi-package"]` and `pi.*` entries
- **Addon manifests**: each `addons/<slug>/package.json` is also Pi-package-shaped
- **Catalog**: `catalog.json` for the piclaw web settings UI

## Layout

```text
piclaw-addons/
├── addons/
│   ├── autoresearch/
│   │   ├── index.ts
│   │   ├── package.json
│   │   └── skills/
│   ├── code-validator/
│   └── ...
├── catalog.json
├── package.json
└── scripts/
    └── sync-catalog.ts
```

The root package points directly at addon entrypoints under `addons/*`.
No duplicate wrapper extensions or copied skill directories are needed.

## Metadata sync

The addon catalog and root package metadata are generated from the addon manifests.

```bash
bun run check:catalog   # validate metadata is in sync
bun run sync:catalog    # regenerate catalog.json + root package metadata
```

`sync-catalog.ts` derives:

- root `pi.extensions`
- root `pi.skills`
- root `agents.skills`
- `catalog.json`

from each `addons/<slug>/package.json`.

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
