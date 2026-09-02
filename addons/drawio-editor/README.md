# piclaw-addon-drawio-editor

Self-hosted draw.io diagram editor extension for piclaw. The add-on version matches the bundled upstream draw.io version; add-on `31.4.2` contains draw.io `v31.4.2`.

Requires Piclaw `>=1.8.0`.

## Install

Open **Settings → Add-Ons** and install **drawio-editor** from the catalog.

## What it does

- Registers an HTTP route at `/drawio/*` serving the draw.io webapp in embed mode
- Provides the `open_drawio_editor` tool for the agent
- Opens `.drawio`, `.drawio.xml`, `.drawio.svg`, `.drawio.png`, and `.xml` workspace files
- Auto-creates a missing target file when opened through `open_drawio_editor`
- Supports PNG, JPG, and SVG export from the reduced export menu
- Saves through `POST /drawio/save` and supports read-only attachment/media preview

## Vendor files

The public add-on tarball includes the self-hosted draw.io webapp. It does not download editor code during installation.

Maintainers update the bundle from the official upstream WAR with:

```sh
bun run --cwd addons/drawio-editor vendor:update
```

The refresh script derives the upstream tag from the add-on version, verifies the pinned WAR SHA-256, copies the browser client subset, checks `EditorUi.VERSION` and `mxClient.VERSION`, and writes `vendor/drawio.meta.json`.

## Architecture

Uses piclaw's `globalThis.__piclaw_registerRoute` to serve the draw.io webapp.
A wrapper page at `/drawio/edit?path=...` (also accepted as `/drawio/edit.html`) embeds the editor in an iframe and handles
the postMessage protocol for load/save via the piclaw raw file API.
