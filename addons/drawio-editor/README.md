# piclaw-addon-drawio-editor

Self-hosted draw.io diagram editor extension for piclaw.

## What it does

- Registers an HTTP route at `/drawio/*` serving the draw.io webapp in embed mode
- Provides the `open_drawio_editor` tool for the agent
- Diagrams stored as `.drawio` XML files in the workspace
- Supports PNG/SVG export

## Vendor files

The draw.io webapp (~44MB) is not included in this addon package. It must be vendored separately:

1. Download from [jgraph/drawio releases](https://github.com/jgraph/drawio/releases)
2. Extract to `vendor/` directory inside this addon's install path
3. Or symlink from an existing piclaw install: `ln -s /usr/local/lib/bun/install/global/node_modules/piclaw/runtime/extensions/viewers/drawio-editor/vendor vendor`

## Architecture

Uses piclaw's `globalThis.__piclaw_registerRoute` to serve the draw.io webapp.
A wrapper page (`/drawio/edit.html`) embeds the editor in an iframe and handles
the postMessage protocol for load/save via the piclaw raw file API.
