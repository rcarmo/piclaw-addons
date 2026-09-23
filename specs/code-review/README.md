# Code Review add-on — workflow specification

Status: **draft for Rui's review; no implementation**. Requested 23 September 2026.
Proposed package: `@rcarmo/piclaw-addon-code-review`.

The add-on gives the user a read-only code and diff review pane, following the
interaction model of a GitHub commit/PR review. The user inspects saved code,
annotates files or ranges, and discusses each concern with a local agent until
resolved. Saved working changes and committed diffs are review inputs; the pane
never edits source. GitHub is an interaction reference, not a required service or
storage backend.

## Implementation gate

All workflows are described in the sibling `features/*.feature` files before any
runtime, database, tool or pane code is written. These files are acceptance
specifications, not executed tests or evidence of working behaviour. No placeholder
step handlers, mock-only passing implementation, package manifest or catalogue
entry is included in this phase.

Specs live outside `addons/` because the current add-on CI automatically discovers
`addons/*/tests/features` and tries to install those packages. After approval, move
the agreed features into `addons/code-review/tests/features` and implement real
step definitions through the existing isolated E2E harness. Keep scenario IDs.

## Required outcomes

- Open a dedicated read-only code/diff review pane without replacing the normal editor.
- Annotate a whole file, a line or a contiguous line range.
- Comment on current saved content, unstaged/staged changes and recent commit diffs.
- Persist comments internally, independently of the browser, agent context window
  and reviewed repository; no source-file markers or committed sidecar comments.
- Add, modify and delete comments, and hold a threaded conversation with an agent.
- Let the agent respond, request clarification, link changes/checks, and resolve
  issues without silently deleting the discussion.
- Let the user continue, correct or reopen that discussion and inspect resolved work.
- Retain guidance when content moves or disappears without attaching it to the wrong code.

## Confirmed decisions

**Explicit dispatch — confirmed by Rui on 23 September 2026**, in reply to message
56881: "send to agent". Posting or editing a comment persists it without queuing
agent work. The user explicitly chooses `Send to agent` to dispatch guidance.
Existing scenarios CR-012, CR-033 and CR-038 cover this separation. This confirms
one workflow decision, not permission to start implementation.

**Default target and picker — confirmed by Rui on 23 September 2026:** suggest
the chat where the review was opened, visibly shown as the target. Offer a picker
to choose another local agent before sending. Selecting a target does not dispatch
work; the explicit send action still applies.

**Agent resolution — confirmed by Rui on 23 September 2026:** the assigned agent
may mark a thread resolved with a public explanation and supporting evidence, or
a reason no code change is needed, without requiring user confirmation. The user
can reopen it. Existing scenarios CR-046, CR-047 and CR-050 cover this workflow;
resolution retains the discussion and its history.

**Saved code only, read-only review — confirmed by Rui on 23 September 2026:**
review saved files and Git diffs, like a GitHub commit/PR review. The user will not
edit source buffers in this pane. Unsaved source buffers, dirty-buffer detection,
save-before-review prompts and source editing controls are out of scope. Only
comment/reply text is editable; comment drafts remain supported. Source views
identify their saved revision or exact diff pair. No GitHub integration or PR
fetching is implied by this interaction model.

## Proposed defaults requiring confirmation

The remaining defaults make the draft testable; they are not implementation approval.

1. **Reply controls:** `Send reply to agent` publishes and dispatches one reply
   atomically at the add-on level. Plain `Post reply` is also available.
   Already queued work cannot be unqueued or undone by deleting its comment.
2. **Target binding and reassignment:** resolve the selected local chat/session
   through a host-resolved alias. New threads inherit the review's target
   suggestion, resolved to a stable local chat identity
   before dispatch. Changing the review default affects only future threads.
   Existing threads retain their bound target until explicit reassignment; alias
   reuse must never silently retarget work. No model run begins just from opening,
   refreshing or installing the pane.
3. **Manual resolution and reopening controls:** the user may also resolve a
   thread. Reopening alone does not start work. A new comment on a resolved thread
   requires an explicit reopen-and-post action.
4. **Safe deletion:** users edit/delete their own comments and can confirm deleting
   a whole thread. Agent messages retain agent authorship; an agent edits/deletes
   only its own replies. Deletion removes bodies from ordinary views/agent retrieval;
   identity tombstones preserve reply order and prevent resurrection. Edited/deleted
   text already delivered to an agent cannot be recalled; show that fact.
5. **Single-operator workspace v1:** server-derived local ownership and selected
   session scope. No public review links, remote peer/A2A reviewers or family-user
   exposure without a separately verified identity/authorisation integration.

The next question is dispatch scope: should `Send to agent` also support sending
several selected comments together as one review, in addition to one thread at a
time? Batch dispatch is not specified yet. No implementation starts during refinement.

## Source and diff contract

- Source and diff views are read-only and load only saved filesystem/Git content.
  No source editor or unsaved-buffer API is needed. A file launch shows its saved
  content; a diff launch shows the explicitly selected comparison.
- Explicit modes: saved source; index-to-worktree (unstaged); HEAD-to-index
  (staged); selected commit against a specified parent. Display the mode, paths,
  revision IDs/content digests and capture time in the pane.
- A review snapshot freezes bytes, line numbers and the chosen diff pair. Normal
  Git diff semantics never execute external diff drivers or text-conversion tools.
  Reads never stage, checkout, reset, commit or write the source tree.
- New/untracked files compare to an empty base when requested. Deleted-file
  comments anchor to the old side. Merge commits require a parent choice; root
  commits may compare to an empty tree. No default branch/base ambiguity.
- Source anchors include workspace/repository identity, path at capture, source
  revision/digest, side and range, bounded selected text and context fingerprints.
  A current projection may follow a verified unique match or rename; the original
  anchor is immutable. Ambiguous/missing matches are marked outdated/orphaned.
- A later file at the same path is not assumed to be the same reviewed file. The
  user may explicitly re-anchor with a recorded mapping; no silent fuzzy reassignment.
  Moving a resolved thread requires explicit reopen-and-re-anchor. The prior
  resolution remains tied to its old anchor and is never validation of the new range.
- Git-less text files support source guidance with diff/history controls disabled.
  Unsupported binary, oversized or invalid-encoding input gives a bounded reason;
  it never loses the existing discussion.

## Persistent model and concurrency

Use an add-on-owned SQLite store under the host-provided data directory. Proposed
logical entities are review, source snapshot/anchor, thread, message/revision,
resolution event, assignment and delivery attempt. These names are design concepts,
not an approved schema. Piclaw's message database stays untouched by direct add-on
SQL. Chat references are pointers, not the sole storage for review conversations.

Every mutation carries a stable request ID and expected record version. The server
checks caller/author/session ownership before lookup and within the write boundary.
Transactions prevent partially saved threads/replies/resolutions. Repeated identical
requests return their original result; conflicting reuse rejects. Concurrent edits,
reply/delete and reply/resolve races produce visible conflicts, not last-writer wins.

A resolved thread remains queryable and can be reopened. Retention is explicit;
no age-based purge is implicit. Disabling/removing the add-on stops its listeners
and tools but retains durable review data for reinstallation. Comment/reply drafts
are private operator records saved through a bounded debounced internal write, never available
as published guidance to an agent. Only acknowledged draft versions are promised
to survive reload/process restart. While offline, unsaved comment text stays in
its composer with a clear warning; never promise recovery of unacknowledged keystrokes.
No dispatch may depend solely on a browser-local state flag.

## Agent interaction contract

An add-on tool surface must allow a scoped agent to list/open review threads,
retrieve current discussion and source revision, reply, report progress, and
resolve with evidence. The UI and tools use the same authoritative records and
version checks. IDs in model text are not permission grants.

- The user selects a target and explicitly dispatches guidance. Persist the
  dispatch intent before asking the host to enqueue; include thread ID, revision,
  scope and a callback/tool reference. No full-repository dump is needed.
- The agent must re-read the latest thread and file revision before action. An
  edited instruction invalidates a resolution against the old thread version.
  No hidden reasoning, raw tool logs or provider credentials are persisted as replies.
- Normal agent tool/approval/budget limits govern source changes. Comments, code,
  diffs and remote links are data; they cannot expand those permissions.
- Receipt states distinguish queued, in progress, waiting for user, blocked, failed,
  unknown outcome and completed work. Agent work state is separate from thread
  state (open/resolved/deleted). Queue acceptance is not evidence of resolution.
- The host enqueue API has no documented idempotency-key field. A crash after
  acceptance but before recording its receipt must remain `unknown`; never claim
  exactly-once execution or automatically replay potentially completed changes.
  Retry/reconcile must be explicit and correlated to the same intent. Repeated
  browser requests for one send intent return its existing delivery state; an
  explicit retry after a definitive rejection is a numbered attempt under that
  intent. Intent creation and the published reply can share a transaction, but
  host queue acceptance cannot be made atomic by a browser transaction.
- Agent replies stay in the annotation thread even after the chat rotates or the
  pane closes. Delivery back to the general timeline may be a linked notification;
  it must not substitute for durable threaded storage. Deleted threads retain a
  body-free operator delivery receipt for queued/in-progress/unknown work; they
  cannot be resent or resurrected by a late completion. Resolving a thread does
  not cancel queued execution. A dispatched worker rechecks thread/assignment
  state before acting and reports superseded work through its delivery receipt.

## Host contract findings and implementation dependencies

Inspected at add-ons `783c673`, core `0beaf44f5`:

- `docs/web-pane-extensions.md` and `runtime/web/src/ui/addon-web-extensions.ts`:
  `registerPane`, priority-based routing, `mount/focus/resize/dispose` and retained
  panes are available. Registering a high-priority source-file handler would hijack
  the existing editor and is prohibited by these specs. A review-specific virtual
  path plus explicit launch affordance needs a real-host spike in both skins.
  No stable add-on editor selection/decorations/context-menu API was established by
  this inspection; direct access to private CodeMirror objects is not a contract.
- `docs/addon-runtime-api.md`: `messaging.getAddonDataDir` provides scoped storage;
  relational state belongs in add-on-owned SQLite. Runtime lifecycle and registered
  authenticated add-on config/actions are available. Do not use pre-auth external
  transport routes for an operator-only review pane.
- `runtime/src/addons/runtime-contributions.ts`: `enqueueAgentMessage` accepts
  local chat, text, mode and optional thread reference, returning row/thread and
  queue receipts. Confirm the exact non-peer caller/target authority during the
  spike. Do not spoof a remote peer or borrow an unrelated operation principal.
- Pi add-on tools can supply structured public replies, but author identity must
  come from trusted tool context. Session replacement/reassignment and direct API
  context require negative tests. Fail closed if the host cannot establish scope.
- Source/diff reads may use bounded workspace APIs and safe Git argument arrays.
  Confirm virtual-path dispatch, canonical worktree identities, and no external
  Git filters before implementing. No private runtime imports.
- The current feature parser supports Feature/Background/Scenario and simple
  Given/When/Then/And/But steps. These specs use that subset (no silently ignored
  Scenario Outline/Examples tables). Narrative and tags are for human navigation.

A missing host API requires a small generic core issue and explicit ownership;
it is not permission to implement the review service inside core or manipulate
private runtime state.

## Validation plan and limits

Each acceptance scenario needs a real assertion and a named implementation step;
no step may fix the UI indirectly via a backup API mutation. Source fixtures and
all Git repositories/databases are disposable. A fake deterministic agent tests
queueing/replies/races without paid provider calls; final integration exercises
actual host routing and isolated execution where authority is confirmed.

- Core and add-on unit tests: anchors/diffs, ownership, author restrictions,
  immutable revision capture, compare-and-set, idempotency and state transitions.
- File-backed process restart tests: pending reviews, conversations, drafts,
  resolution evidence, tombstones and ambiguous delivery recovery.
- Real-host Playwright: Classic/Visual, light/dark, desktop/tablet/phone, keyboard
  and touch range selection, navigation, CRUD, comment-draft close/failure, agent lifecycle,
  and no clipped source/thread controls. Exact-path modules, no bundling shortcuts.
- Git fixtures: staged/unstaged simultaneously, untracked/deleted/renamed files,
  root/merge commits, concurrent working-tree changes and linked worktrees.
- Security: path/symlink escapes, revision/command injection, XSS, comment injection,
  cross-thread access, caller spoofing, revoked sessions, and data limits.
- Performance: bounded source/diff/history pages, lazy conversation pagination,
  no tight or hidden-pane background polling, abort on dispose, stable selection.

Proposed limits for tests: 2 MiB/50,000 lines per text snapshot, 10,000 changed
lines per diff view before a clear limit state, 16 KiB per comment, 100 messages per
history page and 50 threads per list page. Reject oversize before execution;
never truncate a stored review instruction silently. These defaults need
confirmation or adjustment from UI/performance evidence.

No export/import, automatic patch application, GitHub review sync, team approval
rules or network-wide collaboration in v1. Source edits happen through the normal
editor or assigned agent, not through comment CRUD.

## Specification checks

The repository's existing `parseFeature` function parsed all eight feature files:
**103 unique scenarios, 474 scenario steps**, each with an action and observable
outcome. IDs CR-001 through CR-103 are unique and complete. No unsupported
outline/table syntax or runtime/package/catalogue changes were found.

A separate read-only spec review identified dispatch retry, routing inheritance,
draft durability, reply CRUD, resolved re-anchoring and in-flight deletion gaps;
those are now addressed explicitly. This validates document structure and coverage,
not execution of the feature. Step definitions and behaviour tests do not exist yet.

## Workflow files

- `01-pane-and-sources.feature` — explicit launch, read-only saved code, diff modes.
- `02-annotations-and-drafts.feature` — line/range/file guidance and posting.
- `03-comment-management.feature` — message edits, deletion and ownership.
- `04-threaded-agent-work.feature` — dispatch, dialogue, failures and reassignment.
- `05-resolution.feature` — evidence, resolve/reopen and conflicts.
- `06-changing-source.feature` — refresh, movement, rename/delete and stale anchors.
- `07-durability-and-concurrency.feature` — restart/retry/offline/races and lifecycle.
- `08-security-and-accessibility.feature` — authorisation, bounds and both-skin UX.
