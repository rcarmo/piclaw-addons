# writer-fonts

Switch the **document editor** font from a dropdown embedded in the editor
footer. Built for writing: pick a comfortable reading/writing face and the
CodeMirror editor updates live.

## Fonts

| Option | Source | Bundled |
|--------|--------|---------|
| **System** | the shipped UI stack (`-apple-system, …, sans-serif`) | no |
| **Literata** | SIL OFL — Google Fonts | ✅ variable woff2 |
| **Georgia** | OS serif | no |
| **Inter** | SIL OFL — rsms / Google Fonts | ✅ variable woff2 |
| **Noto Sans** | SIL OFL — Google | ✅ variable woff2 |
| **Noto Sans Traditional Chinese** | SIL OFL — Google (CJK TC) | ✅ variable woff2 |
| **New Tegomin** | SIL OFL — Google (Japanese serif) | ✅ woff2 |
| **IBM Plex Sans** | SIL OFL — IBM | ✅ variable woff2 |

Bundled faces are served from the add-on's own asset route and registered with
`@font-face`; "System" and "Georgia" use OS fonts and download nothing.

## How it works

- A `Font` `<select>` is injected into the document editor footer
  (`.editor-frame`). Selecting a font:
  - applies a live `font-family` override to the CodeMirror content
    (`.cm-editor / .cm-scroller / .cm-content`), and
  - persists the choice in `localStorage` under `piclaw_writer_font` **and** the
    editor's native `piclaw_editor_font_family` key, so reloaded or newly opened
    file tabs keep the same font.
- Scope is limited to the in-app document editor; other CodeMirror instances
  (e.g. the plan sidebar) are left untouched.

## Notes / limitations

- Affects the in-app editor. A popped-out editor window is a separate document
  and is not currently themed by this add-on.
- The CJK/JP faces are large (Noto Sans TC ≈ 5 MB, New Tegomin ≈ 3.7 MB woff2);
  they are only fetched when selected.

## License

Add-on code: MIT. Bundled fonts are licensed under the **SIL Open Font License
1.1** — see `fonts/OFL-NOTICE.md` for per-family attribution and upstream
sources.
