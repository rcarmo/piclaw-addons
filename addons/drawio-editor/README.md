# piclaw-addon-drawio-editor

Self-hosted draw.io diagram editor extension for piclaw. Add-on `31.4.4` contains draw.io `v31.4.2`; add-on fixes do not change the pinned vendor version.

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

## Multi-page previews

Read-only attachment previews show page tabs above the drawing. Click a tab or use
Left/Right, Home and End while a tab is focused. Long tab rows scroll horizontally;
single-page drawings do not show an unnecessary tab row. Page names are displayed
as text, not interpreted as HTML.

Navigation uses the bundled editor's decoded page list, including compressed
`.drawio` files and editable-diagram data embedded in SVG/PNG attachments. The
iframe interaction lock stays active and the graph is disabled; page selection
does not create undo edits or send saves. Workspace editing and exports remain
separate and unchanged. Image files without embedded diagram data cannot acquire
extra pages from their rendered pixels.

The optional `preview-pages.browser.test.ts` runs the real vendored application
against disposable loopback fixtures. Set `PICLAW_E2E_DISPOSABLE=1`,
`PICLAW_DRAWIO_CORE_SOURCE=/absolute/path/to/piclaw` and an installed
`PLAYWRIGHT_BROWSERS_PATH`, then run it with Bun from the repository root.

## Vendor files

The public add-on tarball includes the self-hosted draw.io webapp. It does not download editor code during installation.

Maintainers update the bundle from the official upstream WAR with:

```sh
bun run --cwd addons/drawio-editor vendor:update
```

The refresh script uses `piclaw.vendorVersion` for the upstream tag, verifies the pinned WAR SHA-256, copies the browser client subset, checks `EditorUi.VERSION` and `mxClient.VERSION`, and writes `vendor/drawio.meta.json`.

## Architecture

Uses piclaw's `globalThis.__piclaw_registerRoute` to serve the draw.io webapp.
A wrapper page at `/drawio/edit?path=...` (also accepted as `/drawio/edit.html`) embeds the editor in an iframe and handles
the postMessage protocol for load/save via the piclaw raw file API.
