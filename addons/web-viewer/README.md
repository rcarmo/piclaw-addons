# Web Viewer

Authenticated HTML, image, and video viewer routes for Piclaw. Requires Piclaw `>=1.8.0`.

## Install

Open **Settings → Add-Ons** and install **web-viewer** from the catalog, then reload Piclaw.

## Routes

### `/html-viewer/?path=<workspace-file>`

Loads a workspace HTML file through `/workspace/raw` in a sandboxed iframe. The toolbar can refresh the preview, open the raw document in a new tab, or request the source file in the editor.

### `/image-viewer/?path=<workspace-file>`

Displays a workspace image with zoom controls and a checkerboard transparency background.

### `/video-viewer/?path=<workspace-file>`

Plays workspace video through the authenticated raw-file route with native browser controls.

## Security

The add-on registers routes through `globalThis.__piclaw_registerRoute`. Viewer pages use same-origin authenticated file endpoints and restrictive content-security policies. The HTML iframe allows scripts and same-origin assets so generated workspace visuals can load Piclaw's vendored libraries; it does not grant top-level navigation.

The package registers no agent tools or settings pane.
