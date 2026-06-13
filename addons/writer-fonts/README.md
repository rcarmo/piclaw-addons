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

- A `Font` `<select>` is injected into the document editor status bar.
- The chosen font is applied **only in Markdown live-preview mode** (the reading
  surface, tables and frontmatter). In plain/raw view the editor keeps its
  default monospace font and the dropdown is **disabled**.
- Live-preview state is read from the editor's own "Live Preview" toggle button
  (`.active`), mirrored onto a `wf-live` class on `.editor-pane` that scopes the
  override.
- The choice persists in `localStorage` under `piclaw_writer_font`.
- Scope is limited to the in-app document editor; other CodeMirror instances
  (e.g. the plan sidebar) are left untouched.
- Code blocks and inline code intentionally stay monospace, even in preview.
- Both frontends are supported: the **classic** UI places the picker in the
  editor status bar (next to Whitespace / Vim / Save); the **visual** UI appends
  a footer row to the editor frame.

## Notes / limitations

- Affects the in-app editor. A popped-out editor window is a separate document
  and is not currently themed by this add-on.
- The CJK/JP faces are large (Noto Sans TC ≈ 5 MB, New Tegomin ≈ 3.7 MB woff2);
  they are only fetched when selected.

## License

Add-on code: MIT. Bundled fonts are licensed under the **SIL Open Font License
1.1** — see `fonts/OFL-NOTICE.md` for per-family attribution and upstream
sources.
