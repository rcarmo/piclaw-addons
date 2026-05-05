# piclaw-addon-office-tools

Office document read/write tools addon for [Piclaw](https://github.com/rcarmo/piclaw).

## Tools

- **`office_read`** — Extract content from `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp` as Markdown
- **`office_write`** — Create or update Office documents from Markdown/data

## Assets

- `assets/docx-template.zip` — Default DOCX template
- `assets/md2pdf.css` — CSS for Markdown→PDF conversion
- `vendor/pptxgenjs/pptxgen.cjs.js` — PptxGenJS for PPTX generation

## Installation

```bash
cd /workspace/.pi/extensions
bun add @rcarmo/piclaw-addon-office-tools
```
