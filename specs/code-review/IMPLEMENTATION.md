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
- File-backed delivery tests now check concurrent claim-once queueing, independent
  completed/blocked item states, numbered retries after definite rejection,
  unknown delivery without replay and explicit reconciliation against the
  original dispatch after reopen. These are focused CR-040/041/175/176/180
  slices. The browser receipt workflow still needs broader coverage.
- An additional CR-176 fixture now starts two distinct Bun processes against
  the same owned SQLite file: one queue bridge is invoked and the accepted
  attempt is durable. A child deliberately exits after its bridge marker;
  reopening marks the attempt unknown and does not resend. Eight consecutive
  runs passed. The marker models host acceptance; it does not make an external
  host queue transactional with SQLite or prove routing across machines.
- The browser receipt pane now has focused CR-040/041/098 tests: it shows a
  rejected attempt, confirms an explicit numbered retry against the original
  dispatch, and reconciles an unknown attempt with operator-entered evidence
  without another enqueue. Controls and states survive browser reload. The
  fixture uses the real review service behind a disposable browser API; it
  does not prove a remote host receipt or all denial/cancellation branches.
- Focused CR-083/089/119/121 tests check exact byte and line limits, diff
  computation/changed-line budgets, escaped plain-text fallback, bounded
  response pages and independent full-snapshot old/new highlighting. A local
  1.79 MiB saved-source fixture measured roughly 9–13 ms per 300-line page
  before the current change; a 159 KiB staged diff measured roughly 2–4 ms.
  The file action now splits the source for line coordinates but escapes only
  requested rows on large/plain fallback pages. It caches small immutable diff
  row sets per service and file (two entries, bounded by input, row count and
  row-text bytes), and copies output rows to avoid callers mutating a cached
  page. Near-limit diffs still recompute under the existing timeout. These
  numbers are observations, not test thresholds; cancellation, worker-offload,
  repeated-tab idle usage and broad performance gates remain open.
- Multi-file batch tests now cover ordered selection of two saved source files,
  frozen snapshot and thread versions, exclusion of an unselected thread and
  private draft, independent per-thread completion/blocker outcomes, and
  all-or-nothing rejection of changed, retargeted, deleted or cross-review
  items. Matching intent IDs reuse a single dispatch; conflicting payloads
  fail, and a deleted item before enqueue rejects the batch without delivery.
  The accepted-then-agent-start adapter check now verifies per-item authority:
  after one selected item is reassigned to a new chat incarnation, its dispatch
  entry is body-free/superseded and its thread unavailable to the old agent;
  the other selected item remains readable. The unselected published thread
  stays out of the dispatch, but is directly readable because its current
  assignment still matches the agent. Private drafts remain operator-only.
  CR-079 review isolation across two same-target reviews is not established:
  `localContext` v1 verifies the persisted dispatch but exposes only durable
  chat ID/incarnation to the add-on, not the trusted dispatch ID of the current
  prompt. The add-on currently authorises thread reads by assignment, so an
  agent can address a known published thread in another review assigned to
  that same chat. Requiring a caller-supplied dispatch ID could hide reviews
  never dispatched to the chat, but could not guarantee that a prompt started
  by R1 cannot pivot to separately dispatched R2. True per-prompt isolation
  needs a host contract carrying its verified dispatch ID; no core change is
  authorised in this checkpoint. Deleted/resolved before-start variants still
  need separate evidence.
- A disposable browser fixture now selects two of three public threads across
  files, verifies the visible selected count, target and summary, and confirms
  that Preview creates no dispatch. Explicit Confirm records one queue-mode
  dispatch with ordered file IDs, omits the unselected thread/private draft,
  and does not enqueue again on reload. A changed thread before Confirm leaves
  the selection and drawer visible with a conflict and no enqueue. The drawer
  now shows each selected thread ID, guidance version, assignment epoch and
  saved snapshot-file ID from the inert server preview. Changing the selection
  or target requires Refresh preview before confirmation; a stale version is
  re-read without creating an intent. A delayed preview cannot reopen an old
  selection after the user changes it while the request is in flight. These
  are still focused browser checks.
- The browser fixture now commits a public reply while losing its response,
  then retries from the same composer and receives the original reply without
  creating a second message or queueing another agent turn (focused CR-069).
  A body-free operator/actor/review/thread-scoped receipt lookup also supports
  explicit reconciliation after browser reload or from a second tab, including
  a tab that was already open before the marker appeared. No reply is resent
  automatically; absent receipts retain saved drafts. Changed or missing draft
  cleanup is reported without mislabelling a committed public reply, and an
  unreadable browser marker requires explicit confirmation to clear. The
  correlation-only marker uses same-origin browser storage; expiry, sign-out
  handling and long-lived storage policy still need acceptance review.
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
