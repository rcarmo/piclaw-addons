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

## 24 September checkpoint

- Add-on: 90 tests passed and one opt-in host test skipped in the standard run;
  strict add-on TypeScript check passed. The opt-in host test passed separately
  against a disposable Piclaw core worktree and deterministic loopback provider:
  Explorer opened the pane, persisted a comment, queued an explicit dispatch,
  and displayed the agent's evidence-backed resolution after reload. No paid
  provider was called. The fixture now checks that the agent receives a bounded
  `currentSource` status without a live-content hash.
- Core: `make ci-fast` passed in `addon-workspace-context` with 5,640 runtime
  tests passed (seven skipped), 25 feature tests and nine build tests. The new
  queued-public-message regression passed; a later ordinary prompt receives no
  local dispatch authority. The exact verified durable row can be retried for
  crash recovery.
- New add-on tests exercise moved, missing and ambiguous anchors, explicit
  re-anchoring, verified and unverified rename projection, replaced paths,
  current saved-file status, file-backed reopen, rollback, tombstones, interrupted
  delivery and copied-backup access checks. Unknown file identity never grants
  same-path projection; Git rename requires a matching old-side blob. The
  `currentSource` check returns no live source bytes or digest, and reports
  `unverified` when no saved-file identity is available.
- CR-059 now also has a real staged `git mv` fixture: source-mode review to
  staged rename, matching old blob, null Git file identity, immutable original
  anchor and unchanged Git status/index. A fabricated rename with a mismatched
  old blob is rejected. Ambiguous rename candidates and UI behaviour still
  need acceptance coverage.
- A staged rename with a new line inserted before the anchored block also
  passes via real Git capture: the concern projects to the shifted new-side
  range while the original anchor stays at its saved line. Equal-plausibility
  rename candidates and pane navigation remain open.
- CR-061 has an owned Git wrapper that changes one saved file before or after
  a capture boundary. Capture returns coherent source bytes or the explicit
  `changed_during_read` error; it never persists a mixed revision. An atomic
  source replacement stress check accepts only complete file versions or that
  error. The race fixture passed 12 consecutive focused runs and the full
  add-on test run. Broader multi-file race cases remain open.
- CR-183 focused file-backed integrity checks reject cross-review and dangling
  file/thread references through public service methods. Transaction counts,
  foreign-key checks and orphan checks stay unchanged after rejection and reopen.
  They do not cover every projection and delivery mutation path.
- A browser draft-save failure now blocks detaching with unpublished text intact.
  Retrying after storage recovers saves the same draft; the pane updates its
  saved/unsaved label on acknowledgement. This is a focused CR-018/094 check;
  offline reconnect and every pane close/popout route still need host coverage.
- The browser fixture now commits a public reply while losing its response,
  then retries from the same composer and receives the original reply without
  creating a second message or queueing another agent turn (focused CR-069).
  Browser reload before the retry and external concurrent edits remain open.
- These are focused implementation tests, not full CR-001–CR-184 acceptance.
  The copied-backup check reopens the store, not a restored
  Piclaw host. CR-181 tests rejection of a newer unsupported schema; no older
  supported migration exists to inject a failed upgrade. The theme/layout
  matrix, long-history and performance gates remain open.

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
