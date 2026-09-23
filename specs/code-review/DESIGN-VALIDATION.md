# Design validation — 23 September 2026

No runtime implementation, live target, model-provider call, database migration or
service restart is part of this validation.

## Specification structure

The existing `parseFeature` function was extracted from
`tests/addon-e2e/scripts/generate-specs.ts` without executing the generator's file
writes. It parsed eight feature files, 115 unique scenarios (CR-001–CR-115) and
541 scenario steps. Every scenario contains a When and a Then. `git diff --check`
passed. These are parser/structural checks, not executed acceptance tests.

## Static interaction mock

Playwright Chromium revision 1234 loaded a temporary copy of
`review-pane-mock.html` via `file://` with network access disabled. Browser HOME,
cache and temporary paths were disposable, with an allowlisted child environment.
No Piclaw URL or real filesystem/source fixture was used by the mock.

Passed:
- Explorer Review file on an unchanged tracked file and a Git-less file.
- Line-range comment creation, safe display of HTML-like text, inline thread placement.
- Posting without dispatch; one selected multi-file batch and per-thread queued state.
- Split and unified views; source and comparison selection.
- Light/dark rendering, 1440px desktop and 1024/768/390px layouts without shell overflow.
- Keyboard drawer dismissal and target-selection safeguards in the synthetic UI.
- Zero page exceptions and zero HTTP(S) requests.

Screenshots and machine-readable mock results are delivered in the export bundle.

## Compact density and active-theme revision

The revised mock was checked in a disposable loopback server on an OS-assigned
port, with the real `generateHtmlViewerPage` template extracted without importing
its route registration. Two nested frames reproduce the preview layout; a fixture
outer document uses Piclaw's real `paletteVariables` and `visualDefaultPalette`.
No live Piclaw endpoint or profile was accessed. Browser home/cache/temp were
isolated and removed after exit.

Passed:
- Every unwrapped source/unified/split row is 18px high with zero vertical code
  padding, including 1024px, 768px and 390px widths; no shell overflow.
- Host dark palette wins over OS light, and host light wins over OS dark.
- Theme events, inline token changes and insertion/editing of custom theme CSS
  update the mock without reload; code surfaces and primary-button text match.
- A comment draft survives theme changes; range commenting remains functional.
- Git-less explorer review still works on the narrow layout.
- Standalone `file://` opens with a fallback when no host is accessible.
- Removing the preview disconnects host observers/listeners.
- Zero page exceptions or network requests outside the disposable server.

These checks establish mock theme bridging, not native-pane integration. The
preview wrapper's own toolbar styling is host-owned and was not changed.

## Diff tints, action controls and compact toolbar

Additional Chromium checks used a disposable nested-preview fixture with the real
Classic/Visual `settings.css` and shared `settings-addon-buttons.css`. Mock controls
were compared against host-rendered reference buttons (no live instance).

Passed in both skins:
- Computed secondary/primary/danger/disabled styles match the host references,
  including padding, radius, font, colours, hover and keyboard focus. `min-height:
  auto` resolves as auto in flex versus 0px in normal flow; this equivalent minimum
  was normalised in comparisons. Phone font overrides match at 390px.
- Close and overflow boxes are 32px square with SVG glyphs and accessible labels;
  action styling leaves the 18px gutter rows unchanged.
- Desktop toolbar is at most 46px high; source/comparison, target, Threads and Send
  remain visible. View options opens/closes, Wrap works, and Escape dismisses it.
- Empty-selection Send is disabled; selecting threads and sending still queues one
  synthetic batch without resolving those threads.
- Green/red backgrounds match the stated 14%/12% blend over four active code
  surfaces: light, dark, sepia and monochrome. Text colours remain theme-owned;
  selected lines keep the diff tint. No horizontal shell overflow at 768/390px.
- No page exceptions or requests outside the disposable server.

## Limits

The mock is intentionally in-memory. Reload clears its state. Queue feedback is
simulated and never contacts an agent. It does not implement persistent anchors,
re-anchoring, full Markdown, all CRUD controls, real context expansion, actual Git,
Piclaw pane mounting or host-authorised dispatch. Saved-source thread projection
in a synthetic diff is labelled as fixture projection and is not anchor evidence.

Real integration still requires the generic host contracts identified in
`PANE-DESIGN.md`, scoped state/security tests, file-backed restart tests and
Classic/Visual browser validation against an explicitly disposable Piclaw target.

The read-only delegate audit timed out; host findings were verified directly in
core `9c038af8f`. The optional workspace visual-design preference file was absent;
the visual-design skill defaults were used.
