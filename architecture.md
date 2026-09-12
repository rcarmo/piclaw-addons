# Architecture

## Catalog

`catalog.json` is the central index consumed by the piclaw web UI. It is auto-generated from each addon's `package.json` by the `sync-catalog` workflow and should never be hand-edited (except for the `owner` and `contributors` fields).

Each entry:

```json
{
  "slug": "proxmox",
  "name": "@rcarmo/piclaw-addon-proxmox",
  "version": "0.1.8",
  "install": {
    "kind": "tarball",
    "spec": "https://rcarmo.github.io/piclaw-addons/packages/piclaw-addon-proxmox-0.1.8.tgz"
  },
  "owner": { "login": "rcarmo", "url": "https://github.com/rcarmo" },
  "contributors": [],
  "updatedAt": "2026-04-29"
}
```

| Field | Purpose |
|---|---|
| `install.kind` | First-party add-ons use `tarball` |
| `install.spec` | Public GitHub Pages tarball URL used by the runtime installer |
| `owner` | Primary maintainer — hand-managed, preserved by sync |
| `contributors` | Additional contributors — hand-managed |
| `updatedAt` | Date of last git commit to the addon directory (auto) |

## Installation flow

1. The piclaw web UI fetches `catalog.json` from GitHub Pages.
2. The user picks an add-on and clicks Install.
3. The runtime downloads the public tarball URL from `install.spec` and installs it into `/workspace/.pi/extensions/node_modules/`.
4. The local `.pi/extensions/package.json` dependency record is updated to keep the same public tarball URL for later upgrade/remove flows.
5. The user reloads Piclaw to load the runtime entry (`pi.extensions`) and browser entry (`pi.web.entries`).

First-party install/remove must remain **zero-auth**. Do not route these flows back through npmjs.org or authenticated GitHub Packages reads.

## Settings-pane config flow

Settings panes are split across two environments:

### Browser side (`web/index.ts`)

- registers a settings pane via the runtime globals exposed by piclaw
- renders with `globalThis.__piclawPreactHtm` / `globalThis.__piclawPreact`
- reads/writes non-secret config through the local authenticated config API:
  - `GET /agent/addons/api/<addon>/config`
  - `POST /agent/addons/api/<addon>/config`
- uses `/agent/keychain` for secrets

### Runtime side (`index.ts` / `extension.ts`)

- registers direct config handlers with `globalThis.__piclaw_registerAddonConfigApi(...)`
- persists non-secret settings in extension KV / runtime storage
- resolves secrets from the keychain at runtime

The old browser → slash-command config bridge is now legacy-only compatibility behavior. New or updated add-ons should register direct config handlers instead.

## Repo layout

```
piclaw-addons/
├── addons/               # One directory per addon (independent npm packages)
├── assets/               # Diagrams and static site assets
├── lib/compat/           # Shared compatibility shims (not published separately)
├── scripts/
│   ├── browser-relay/    # WSL2 browser relay helper (see its README)
│   └── sync-catalog.ts   # Catalog + root package metadata generator
├── build.ts              # Static docs site builder
├── catalog.json          # Auto-generated addon index
├── package.json          # Root package manifest (@rcarmo/piclaw-addons)
└── .github/workflows/
    ├── build.yml              # Docs + GitHub Pages deploy
    ├── sync-catalog.yml       # Catalog auto-regeneration on addon change
    ├── validate-metadata.yml  # Metadata validation on PRs and pushes
    ├── publish.yml            # GitHub Packages publish on catalog change
    └── triage-issues.yml      # Auto-label issues by addon and notify owner
```

## CI/CD

| Workflow | Trigger | What it does |
|---|---|---|
| `validate-metadata` | pull requests and pushes to `main` | Runs catalog validation, Earendil type-check/tests, standalone imports, and `bun pm pack --dry-run` |
| `sync-catalog` | relevant `addons/**` or catalog-script pushes to `main` | Regenerates `catalog.json` and root package metadata, then commits changes |
| `build` | relevant catalog, build, asset, or `addons/**` pushes to `main` | Runs opted-in add-on UX tests, builds the docs site and tarballs, then deploys GitHub Pages |
| `publish` | add-on manifest pushes to `main` | Publishes version-bumped add-ons to GitHub Packages and skips unchanged versions |
| `triage-issues` | issue opened | Scores issue text against addon slugs/tags, posts comment + applies `addon:<slug>` label |

## Metadata commands

```bash
bun run check:catalog   # Validate catalog.json is in sync with addon package.json files
bun run sync:catalog    # Regenerate catalog.json + root package.json metadata
```
