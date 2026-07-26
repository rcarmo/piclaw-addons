# EML Viewer

Browser preview for `.eml` and `message/rfc822` attachments. Requires Piclaw `>=2.0.0`.

## Install

Open **Settings → Add-Ons** and install **eml-viewer** from the catalog, then reload Piclaw.

## Route

The add-on registers `/eml-viewer`. The viewer accepts a required `media` query parameter and an optional `name` parameter supplied by Piclaw's attachment preview integration.

## Rendering

Parsing runs in the browser. The viewer:

- decodes encoded message headers
- shows sender, recipients, subject, and date metadata
- prefers a sanitised HTML body when present
- falls back to plain text
- resolves CID image references from MIME message parts

The route uses `no-store` responses. The package registers no agent tool or settings pane.
