# piclaw-addon-export-timeline-pdf

Export chat timelines to PDF with inline avatars and referenced message pills.

## Features

- Exports any chat timeline range to a self-contained PDF via `wkhtmltopdf`
- Inlines agent/user avatars as base64 data URIs (no broken images in PDF)
- Renders `message:NNN` references as styled pills with author + preview
- Supports light/dark themes, date ranges, row ranges, and last-N filters
- Read-only — never opens SQLite or writes auth state

## Requirements

- `wkhtmltopdf` installed and on PATH
- Piclaw web server running locally

## Usage

The agent uses the `export-timeline-pdf` skill automatically when asked to export a timeline to PDF.

Manual invocation:

```bash
bun <addon-path>/scripts/export-timeline-pdf.ts --chat web:default --last 50
```

See the skill SKILL.md for full option reference.
