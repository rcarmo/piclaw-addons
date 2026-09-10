# Office Tools

Read OOXML documents and create Office/PDF files from Markdown. Requires Piclaw `>=1.8.0`.

## Install

Open **Settings → Add-Ons** and install **office-tools** from the catalog.

## Tools

### `office_read`

Reads `.docx`, `.xlsx`, or `.pptx` and returns Markdown. Legacy `.doc`, `.xls`, and `.ppt` files are rejected. ODF files are not supported by this tool.

### `office_write`

Creates `.docx`, `.xlsx`, `.pptx`, or `.pdf` from Markdown. Output paths must remain inside the workspace.

- DOCX uses the bundled `assets/docx-template.zip`.
- XLSX is generated with the packaged spreadsheet implementation.
- PPTX uses the vendored PptxGenJS build.
- PDF uses the bundled `assets/md2pdf.css` and a package-local CDP renderer. It launches an isolated headless Edge/Chrome/Chromium profile on a free debugging port rather than attaching to unrelated browser automation sessions.

## Assets

- `assets/docx-template.zip` — default DOCX template
- `assets/md2pdf.css` — Markdown-to-PDF stylesheet
- `vendor/pptxgenjs/pptxgen.cjs.js` — PPTX generator

The package uses the shared `@sinclair/typebox` peer. PDF generation is self-contained and does not import Piclaw runtime internals.
