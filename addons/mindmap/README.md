# Mindmap Editor

A workspace editor for `.mindmap.yaml` and `.mindmap.yml` files. Requires Piclaw `>=1.8.0`.

## Install

Open **Settings → Add-Ons** and install **mindmap** from the catalog, then reload Piclaw.

## Use

Open a mindmap YAML file from the workspace explorer or with `open_workspace_file`. The add-on registers a specialised pane and loads its bundled D3, YAML, editor JavaScript, and stylesheet assets.

The editor provides:

- horizontal, vertical, radial, and force-directed layouts
- zoom and fit controls
- undo and redo
- node cut, copy, paste, add, and delete actions
- automatic save back to the workspace file
- conflict monitoring when the file changes outside the pane

Only one editor instance owns a pane container at a time. Repeated open requests focus an existing tab instead of stacking duplicate editors.

## Format

Files are YAML mindmaps consumed by the bundled browser editor. Keep the `.mindmap.yaml` or `.mindmap.yml` suffix so Piclaw selects the pane.
