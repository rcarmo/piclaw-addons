# Code Review implementation checkpoints

Branch `feat/code-review`, worktree `code-review-implementation`. Implementation
was authorised on 23 September 2026. No merge, runtime installation or restart
has been requested by this branch.

## Ownership

- Add-on data/service/source/pane: @addons-3 (this worktree).
- Generic host actions, virtual panes and trusted local context: @addons,
  `/workspace/piclaw-worktrees/addon-workspace-context`, branch
  `feat/addon-workspace-context`.
- Agreed namespace: `piclaw://addon/code-review/<review-id>`.
- Host `localContext` v1: canonical workspace root/ID, host-derived operator or
  explicit local-dispatch agent identity, stable chat branch incarnation, target
  lookup, queue-only enqueue. No ambient-chat fallback. Ordinary legacy/direct
  prompts require an explicit Send to agent before review tool access.
- Explicit Refresh in the first slice; no polling or unverified event channel.

## First implemented slice (not release-ready)

- File-backed SQLite with schema checks, snapshots/blobs, immutable anchors,
  projections, discussions/revisions/tombstones, private drafts, dispatch/items,
  attempts, events and body-free idempotency receipts.
- Source and bounded safe Git capture, staged/unstaged/commit/root/merge paths,
  regular UTF-8 file enforcement and basic rename/deletion/untracked handling.
- Exact/context anchor mapping, explicit remap and stale-resolution checks.
- Versioned comment/reply/resolve/reopen/reassign and deletion.
- Atomic single/batch and reply-and-send intents; one enqueue claim, unknown
  recovery, safe numbered retry, explicit reconciliation and per-item work.
- Packaged Lezer source highlighting and diff renderer primitives.
- Direct authenticated action adapter and agent review tool (host v1 required).
- First native pane with real API reads/writes, file/range threads, draft autosave,
  comparison selection, agent selection, explicit batch queue and reload.

Current local checks: **46 tests, 471 assertions**, including one Playwright test
using the real add-on service with a fake trusted host and owned SQLite/source
fixtures. Strict add-on TypeScript check passes. These are not 184 completed
acceptance scenarios and are not full Piclaw integration proof.

## Required before release

- Complete pane behaviour: history/review/agent selection UX, draft navigation and
  conflict recovery, original-context navigation, long message/thread pagination,
  multi-file Add file semantics, context expansion, receipt retry/reconcile controls,
  focus/drawer keyboard handling, theme/Settings button parity and native titles.
- Confirm full snapshot limits, total diff/render budgets, cancellation and path/
  capture race handling. Complete property/fuzz/source/worktree tests.
- Complete deletion, replay and recovery invariants across every retrieval surface;
  mutation retry and preview-payload edge cases; migration/backup failure fixtures.
- Map all CR-001–CR-184 to actual executable assertions, implement real step handlers
  and run them. `coverage.ts` deliberately reports acceptance pending; unit ID
  references are trace links only.
- Integrate the tested core host contract and run actual queue/provenance/restart
  and Classic/Visual browser tests on disposable Piclaw, not just the fake host.
- Full regression/typecheck/catalog/standalone/package/CI/platform gates and final
  compatibility version, docs/screenshots, review and approved merge/deployment.

The complete original acceptance scope is unchanged. No catalogue entry has been
published for this unfinished package; the compatibility range in package.json is
provisional and must be raised to the version providing the required host APIs.
