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
