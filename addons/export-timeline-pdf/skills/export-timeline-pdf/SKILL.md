---
name: export-timeline-pdf
description: Export a chat timeline to a PDF using the internal localhost export endpoint and wkhtmltopdf.
distribution: public
---

# Export timeline PDF

Export chat history through piclaw's internal localhost HTML export endpoint and render it with `wkhtmltopdf`.

## Steps

1. Export the last 50 messages:
   ```bash
   bun ../scripts/export-timeline-pdf.ts --chat web:default --last 50
   ```

2. Export a date range:
   ```bash
   bun ../scripts/export-timeline-pdf.ts --chat web:default \
     --from "2026-03-01T00:00:00Z" --to "2026-03-05T23:59:59Z"
   ```

3. Export a specific message range by row ID:
   ```bash
   bun ../scripts/export-timeline-pdf.ts --chat web:default \
     --from-row 1234 --to-row 1300
   ```

4. Dark theme:
   ```bash
   bun ../scripts/export-timeline-pdf.ts --chat web:default --last 20 --theme dark
   ```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--chat` | Chat JID to export | `web:default` |
| `--from` | Start timestamp (ISO 8601) | (all) |
| `--to` | End timestamp (ISO 8601) | (all) |
| `--from-row` | Start message row ID | (all) |
| `--to-row` | End message row ID | (all) |
| `--last` | Export only the last N messages | (all) |
| `--theme` | `light` or `dark` | `light` |
| `--out` | Output PDF path | `/workspace/exports/timeline-<chat>.pdf` |
| `--port` | Piclaw web port | auto-detect / `8080` |
| `--auth-key` | Internal export auth key | env/config lookup |
| `--html-only` | Save HTML sidecar without rendering PDF | off |

## Auth

The internal endpoint is only available on localhost and requires an internal auth key.
The script resolves it in this order:

1. `--auth-key`
2. `PICLAW_EXPORT_AUTH_KEY`
3. `PICLAW_INTERNAL_SECRET`
4. `PICLAW_WEB_INTERNAL_SECRET`
5. `web.internalSecret` from `/workspace/.piclaw/config.json`

## Prerequisites

- `wkhtmltopdf` must be installed and available on `PATH`
- piclaw web server must be running locally

## Notes

- The script is read-only: it never opens SQLite and never writes auth/session state.
- The HTML export endpoint is `GET /internal/export/timeline`.
- The script writes an HTML sidecar next to the PDF for inspection.
