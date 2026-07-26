# piclaw-addon-drawio-editor

Self-hosted draw.io diagram editor extension for piclaw.

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

The draw.io webapp (~44MB) is not included in this addon package. It must be vendored separately:

1. Download from [jgraph/drawio releases](https://github.com/jgraph/drawio/releases)
2. Extract to `vendor/` directory inside this addon's install path
3. Or symlink from an existing piclaw install

## Architecture

Uses piclaw's `globalThis.__piclaw_registerRoute` to serve the draw.io webapp.
A wrapper page at `/drawio/edit?path=...` (also accepted as `/drawio/edit.html`) embeds the editor in an iframe and handles
the postMessage protocol for load/save via the piclaw raw file API.
