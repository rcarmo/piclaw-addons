# piclaw-addon-office-viewer

Office document viewer addon for [Piclaw](https://github.com/rcarmo/piclaw).

Opens `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`, `.doc`, `.xls`, `.ppt`, `.rtf`, `.csv` files in a self-contained browser-side viewer with no WASM or HTTPS requirements.

## Libraries

All viewer libraries are vendored and served locally:

| Library | Format | Source |
|---|---|---|
| [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) | `.docx` / `.odt` | MIT |
| [SheetJS (xlsx)](https://sheetjs.com/) | `.xlsx` / `.csv` | Apache-2.0 |
| [PptxViewJS](https://github.com/meshesha/PptxViewJS) | `.pptx` / `.ppt` | MIT |
| [JSZip](https://stuk.github.io/jszip/) | (zip dependency) | MIT |
| [Chart.js](https://www.chartjs.org/) | (chart dependency) | MIT |

## Agent tool

Exposes the `open_office_viewer` tool:

```
open_office_viewer(path: "/workspace/doc.docx")
→ Returns a viewer URL the user can open in their browser.
```

## Route

Serves viewer assets at `/office-viewer/*`.

## Installation

```bash
cd /workspace/.pi/extensions
bun add @rcarmo/piclaw-addon-office-viewer
```
