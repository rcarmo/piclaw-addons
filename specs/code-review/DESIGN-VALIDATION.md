# Design validation — 23 September 2026

No runtime implementation, live target, model-provider call, database migration or
service restart is part of this validation.

## Specification structure

The existing `parseFeature` function was extracted from
`tests/addon-e2e/scripts/generate-specs.ts` without executing the generator's file
writes. It and `@cucumber/gherkin@41.0.0` parsed 12 feature files, 184 unique scenarios
(CR-001–CR-184), 917 scenario steps and 26 background steps. Both parsers returned
matching scenario names and step text. Every scenario contains a When and a Then;
IDs are unique and complete, and no unsupported outline/table syntax is used.
`git diff --check` passed. These are parser/structural checks, not executed
acceptance tests. Standard-parser dependencies were installed in an owned temporary
root with lifecycle scripts disabled and no credentials passed to that process.

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

## Native title tooltip pass (prior revision)

A disposable iframe fixture exercised both Classic/light and Visual/dark at 1440,
768 and 390px widths. All buttons, inputs, selectors/options, textareas, links and
disclosure controls (including hidden and generated elements) had nonempty native
`title` attributes in each tested state: saved file, unified/split diff, thread
list, target mismatch, queued/resolved threads, reply/new-thread rerenders and
Git-less files. No custom tooltip element was introduced.

Assertions verified the current disabled reason, posting without dispatch, Viewed
without dispatch, Include in send selection, one explicit batch and unchanged
18px rows, 32px icon boxes and compact desktop toolbar. Drawer label clicks select
the associated checkbox. Both skins had zero page exceptions or external requests.
Native browser tooltip rendering/timing and touch support are browser-owned;
these checks validate the attributes and copy, not guaranteed native popup display.

## Syntax highlighting and removal of Viewed

The mock now embeds precomputed synthetic source fixtures using `@lezer/javascript`
1.5.4 (TypeScript dialect), `@lezer/markdown` 1.6.3, and `@lezer/highlight` 1.2.3.
`classHighlighter` plus the function-tag role matches Piclaw's token convention;
scoped CSS follows `theme-syntax.css`. The mock loads no runtime grammar or editor
bundle. Its parent-theme token bridge now includes the syntax-role variables.

Both skins passed disposable Chromium checks for:
- TypeScript tokens, Markdown source headings, and unhighlighted Git-less text.
- Exact rendered source text in file/unified/split views, old-side keyword tokens,
  and no change to addition/deletion backgrounds or 18px rows.
- Multiline comments/template strings, escaped hostile source, trailing empty lines,
  and raw-line mismatch fallback without trusting out-of-date fixture HTML.
- Active host syntax-role colours, including functions and booleans; live palette
  changes do not rerender code or discard a draft.
- No Viewed UI or state; the remaining checkboxes only select threads for sending.
- Native title coverage, new comment without execution, one explicit batch send,
  1024/768/390px widths, and no shell overflow or page exceptions.
- No requests outside the owned disposable fixture server.

The source fixtures are design examples, not a runtime parser API. Future arbitrary
files need the bounded public highlighter or explicitly packaged parser dependency
described in `PANE-DESIGN.md`.

## Limits

The mock is intentionally in-memory. Reload clears its state. Queue feedback is
simulated and never contacts an agent. It does not implement persistent anchors,
re-anchoring, full Markdown, all CRUD controls, real context expansion, actual Git,
Piclaw pane mounting or host-authorised dispatch. Saved-source thread projection
in a synthetic diff is labelled as fixture projection and is not anchor evidence.

Real integration still requires the generic host contracts identified in
`PANE-DESIGN.md`, scoped state/security tests, file-backed restart tests and
Classic/Visual browser validation against an explicitly disposable Piclaw target.

The later delegated Gherkin consistency review also timed out; no independent
review pass is claimed. The new pane/host/data scenarios were checked directly
against the design and confirmed decisions, preserving existing scenario IDs.

The read-only delegate audit timed out; host findings were verified directly in
core `9c038af8f`. The optional workspace visual-design preference file was absent;
the visual-design skill defaults were used.
