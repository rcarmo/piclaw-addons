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
- PDF uses the bundled `assets/md2pdf.css` and the host PDF renderer.

## Assets

- `assets/docx-template.zip` — default DOCX template
- `assets/md2pdf.css` — Markdown-to-PDF stylesheet
- `vendor/pptxgenjs/pptxgen.cjs.js` — PPTX generator

The package uses the shared `@sinclair/typebox` peer. PDF generation imports Piclaw's `../../browser/cdp-browser/cdp.ts` helper, so this package is not self-contained for that operation.
