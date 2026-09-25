# Code Review pane — UX and integration design

Design only, 23 September 2026. No add-on runtime, database migration or host changes.
Rui asked for a GitHub/Gitea-style review surface, not a source editor. Ordinary
CRUD behaviour uses conventional defaults; further checklist approval is unnecessary.

## Start from either a file or a change set

**Explorer → Review file is a primary workflow.** Select any saved text file and
choose Review file from the selected-file actions; make the same action reachable
from the preview header on touch devices. Do not require Git, a changed file, a
commit, an open editor, or an existing review. Double-click and Open in editor keep
their current behaviour. Review file opens a separate tab named `Review · filename`.

Capture the saved bytes, digest and timestamp on launch. Show the full read-only
file, a line-number gutter and file-level discussion. A clean tracked file works
exactly like a changed file. A file outside Git shows `Saved file` without unusable
commit selectors. For binary/oversized files show a reason; never silently open an
editable buffer instead. Existing reviews appear in a small recent-review picker;
opening a file alone does not dispatch anything.

**Review changes / Review commit** opens the same pane with a fixed comparison:
index → saved worktree, HEAD → index, or selected commit → selected parent. The
changed-files navigator lists paths, change type, additions/deletions and unresolved
counts. A saved-file review can switch to a Git comparison when available without
moving its old comments onto unrelated diff lines. The current entry context is
explicit; switching view does not rewrite anchors.

An explorer file launch need not spawn a new database object every time: offer an
existing active review for the same owner/worktree/path, or New review explicitly.
Separate intentional reviews of the same path remain possible. Reopen by review ID,
not by deriving identity from today's filename. Cross-file batches belong to one
review; adding another file requires an explicit Add file action.

## Pane layout

Use Piclaw's existing tabs, popout button, splitters and chat surface. The add-on
renders only inside its pane container: no second app header, account navigation,
repository management sidebar or duplicate chat composer.

1. **Review toolbar.** One compact row: source/comparison selector, target-agent
   picker, Threads, `Send to agent (N)` and an overflow button. The tab title already
   identifies the review: no repeated review heading, subtitle or Read-only badge.
   Refresh, Wrap and Split/Unified live in View options. Path and revision appear
   together in the file header. Send is disabled with an empty selection; its count
   appears only when nonzero. Queue mode is explained at submission, and a delivery
   status row appears only after sending. The desktop bar is at most 46px high.
2. **Files rail.** About 210px wide for multi-file reviews, collapsible and hidden
   by default for a one-file explorer review. Show change badges, `+/-` counts,
   and open-thread count. Filter by path / unresolved. No Viewed checkbox or
   reading-progress state: this workflow is about actionable concerns. Only the selected file's content
   needs mounting; previous/next file navigation preserves scroll and drafts.
3. **Code/diff region.** Full-width main content, sticky filename/hunk header and
   stable line numbers. Default unified diffs at normal pane widths. Split view is
   available when useful above about 1100px of pane width; do not squeeze two code
   columns into a tablet. Context expansion, wrap toggle and next-change controls
   operate on saved snapshot data. Long lines scroll inside code, not the shell.
   Source uses 12px monospace text on an 18px line box, with zero vertical row
   padding and narrow gutters. Keep that density on tablets/phones; do not apply
   toolbar button minimum heights to code-row controls.
4. **Inline threads.** Insert a discussion beneath its ending line or range in
   unified/file view; in split view place it beneath a paired row with the cited
   side explicit. Avoid floating chat bubbles that lose their line context. A
   compact collapsed row shows author, snippet and state. Expanded threads show
   public messages, editable user text, resolution evidence and send controls.
5. **Review drawer.** `Threads` opens a right drawer, not a permanent third column.
   It lists pending-to-send, open, resolved and outdated threads across the review.
   Selecting an item reveals its file/range; outdated threads show their original
   snippet. A checkbox selects eligible threads for one batch. `Send to agent`
   opens the same drawer in submission mode with selected items and target.

Use a pane `ResizeObserver` / container-width rules, not browser width: the pane
may occupy half a wide desktop. At 720–1100px collapse the file rail to a Files
button and overlay the review drawer. Below 720px keep unified/source view, use
full-width drawers and wrap the toolbar; only code can scroll horizontally. Match
Settings' per-skin action sizing instead of inflating all buttons on narrow screens.
Keep space between adjacent controls and native keyboard focus; icon-only actions
use consistent 32px square boxes. Code-line selection remains dense: keyboard
selection and the larger Add comment/range controls must
provide alternatives to precise gutter taps. Diff colour is supplementary: retain
`+`, `−`, old/new numbers and text labels. Both Classic and Visual inherit their
own host tokens and focus styles; no hardcoded GitHub skin.

Use active Piclaw CSS tokens, including `--bg-code`, `--text-code`,
`--font-family-mono`, `--success-color`, `--danger-color` and
`--accent-contrast-text`. Addition/deletion rows tint the current `--bg-code` with
14% green (`#2da44e`) or 12% red (`#cf222e`) respectively; they do not replace it
with another light/dark palette. Preserve `--text-code` and explicit +/- markers.
Use dedicated diff hues so monochrome themes cannot collapse both semantic colours
into the same grey. Range selection adds the accent indicator without erasing the
row's green/red background. Browser/OS dark mode must not override a Piclaw theme
or custom tint. Theme changes must not
remount source or discard drafts/selections. Native panes inherit directly.

For this standalone HTML preview only, a small same-origin bridge traverses the
nested viewer frames to the Piclaw document, copies an allowlist of computed
colour/font tokens and listens to `piclaw-theme-change` and theme/style mutations.
It never writes to the host, polls, reads application state or weakens the viewer
sandbox. Its observers/listeners detach on page exit. When opened from disk or
under an inaccessible parent, it uses a readable light/dark fallback; a downloaded
file cannot know the active theme in an unrelated Piclaw tab.

### Action and close controls

Use the appearance rules from `runtime/web/static/common/css/settings-addon-buttons.css`
with Classic's overrides in `classic/css/settings.css`: padding, font sizing/weight,
border/radius, background, primary text contrast, hover, disabled and focus-visible.
The mock embeds a scoped snapshot of these rules and detects Classic/Visual from
the hosting shell's asset paths; it does not assume Settings CSS styles other panes.
A native implementation should use a supported shared action style or a narrowly
scoped equivalent; do not wrap the pane in a fake Settings container to get styles.

Use the tab strip's 12px SVG X, not a typographic multiplication sign, for close
buttons. Every close/overflow icon has a 32px square box, centred glyph, accessible
label and tooltip; hide the file-rail close action when the rail is not a drawer.
Native Piclaw owns the tab's own close control; do not add another close button in
the review toolbar. Gutter, context-expansion and file-navigation controls explicitly
opt out of action-button geometry. Do not add arbitrary compact/link variants to
ordinary Reply, Resolve, Post and Send buttons.

### Native helper tooltips

Every actionable control has a concise standard HTML `title`: action buttons,
close/overflow icons, selectors/options, checkboxes, file navigation, gutter actions,
inputs, textareas, links and disclosure summaries, including dynamically rendered
controls. No custom tooltip component, tooltip overlay or tap-to-help interception.
Copy states purpose and side effects instead of repeating the label; text reflects
disabled reasons such as no selection, already queued, resolved or target mismatch.

Use visible `Include in send` labels for thread checkboxes; Open/Resolved is a
separate status. Checking selects a thread only and does not send, approve code or
resolve it. There is no Viewed checkbox. Posting and queueing remain explicitly distinguished.
Native `title` complements accessible labels, not replaces them. Browser tooltip
display on focus, touch or disabled controls varies; do not promise a custom fallback.
Keep essential distinctions visible in labels and submission feedback, and native
disabled controls inert.

## What to reuse from GitHub and Gitea

Reuse their familiar review mechanics:

- Changed-file navigation, sticky file headings and collapse/expand.
- Old/new line numbers, unified/split mode and bounded context expansion.
- Gutter `+` on hover/focus; line click plus Shift-click for a range. On tablet,
  tap a gutter line, choose range end, then Add comment; no drag-only or hover-only
  actions. Source selection remains copyable and never contenteditable.
- Inline Markdown threads, author/time/edited labels, Reply, Resolve and Reopen.
- Pending review selection and a final submission drawer with a count and summary.
- Outdated-comment context tied to the originally reviewed revision.

Adapt the meaning to Piclaw:

- `Post comment` saves immediately but does not notify/start the agent. Show `Not
  sent` separately from `Open`. Pending-to-send is not an unpublished draft.
- `Send to agent` replaces Submit review / Request changes. One batch queues one
  agent instruction referencing its item IDs; it does not merge the threads.
- A submission may carry a short optional overall instruction, versioned with its
  dispatch intent. Replies and evidence remain per thread. An overall dispatch
  activity note never substitutes for addressing the individual concerns.
- The target is the opening chat by default, with a local-agent picker. Existing
  bound threads cannot silently change target; mixed-target batches prompt explicit
  reassignment or separate sends. Busy targets receive queue mode, never steer.
- Do not copy PR Approve/Merge/branch-protection semantics. Resolving a concern is
  not approving a branch or committing code. No Suggestion → Apply patch button in
  v1; source changes happen through authorised agent work outside the review pane.

GitHub reference: [Reviewing proposed changes](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request).
Gitea reference: [Pull requests](https://docs.gitea.com/usage/pull-request).
These references inform interaction patterns; neither service is required at runtime.

## Comments, actions and ordinary defaults

A range composer shows `src/main.ts · new lines 18–22 · snapshot a7d4…` above the
text. Markdown preview is optional; links/code render through the host's sanitised
rendering contract or an equivalent scoped safe renderer. Never inject raw HTML.
Post saves the comment and exposes a send checkbox. Autosaved drafts are labelled
Draft, private to the operator and excluded from agent retrieval and batches.

Edit/Delete sit in the author's overflow menu. Deleting one message leaves a
`Comment deleted` tombstone and existing replies. Deleting a whole thread is a
separate confirmed action. Previously delivered instructions cannot be recalled;
keep a body-free work receipt. Agents may edit their own replies, not human text.

Resolution collapses the thread with a reason and evidence link; reopen is always
available to the user. Reopening does not send work. A source refresh never resolves
comments. If selected lines moved uniquely, project the marker with a visible
`Moved since review` label; ambiguous/deleted anchors become Outdated and remain
readable in original context. Refresh announces new saved code without snapping
scroll or rewriting the draft's selected revision.

Code is never dirty; a failed-to-persist comment draft may block close through the
host's generic dirty mechanism. Do not wire that to source saving. `Cmd/Ctrl+S` in
a comment saves its draft; successful draft persistence clears the dirty indicator.
If an unknown virtual path reaches the normal editor fallback, fail with a disabled
add-on notice rather than attempting to open or save a synthetic filesystem path.

## Piclaw integration: evidence and gaps

Inspected core `9c038af8f`, with no core changes. All paths below are under
`/workspace/piclaw`.

**Existing hooks**

- `runtime/web/src/ui/addon-web-extensions.ts`: `__piclaw_web.registerPane` /
  `registerWorkspacePane`, `registerStandaloneTabUrlResolver`,
  `registerSettingsPane`, `getCurrentChatJid`. The last is a UI suggestion sourced
  from globals/URL and even falls back to `web:default`; it is not authentication.
- `runtime/web/src/panes/pane-types.ts`: `WebPaneExtension`, `PaneInstance`,
  `mount/focus/resize/dispose`, `onDirtyChange`, transfer hooks. Register the review
  with `capabilities: ['readonly']`, `placement: 'tabs'`, and handle only its own
  virtual path, proposed `piclaw://code-review/<review-id>`. Never claim `.ts`,
  `.md` or all text files in `canHandle`.
- `runtime/web/src/ui/use-editor-state.ts`: internal `openEditor(path, options)`
  supports labels and `paneOverrideId`; tab identity is the path. A review-specific
  virtual path prevents collisions with the same file's ordinary editor tab.
- `runtime/web/src/ui/app-pane-runtime-orchestration.ts`: mounts registered panes
  directly; generic panes can fetch their own data. Binds dirty/close callbacks,
  supports retained panes and transfer. Source auto-refresh only calls panes with
  `setContent`; the review pane should own snapshot refresh, not implement source
  saving. Start with ordinary mount/dispose and durable drafts, not retention.
- `runtime/src/channels/web/handlers/addon-config-api.ts`: direct authenticated
  add-on actions receive `(payload, Request)`; no typed operator context is passed.
  Use `/agent/addons/api/code-review/<action>`, not slash-command round trips.
- `runtime/src/addons/runtime-contributions.ts`: scoped `messaging.getAddonDataDir`,
  `lifecycle.onShutdown`, runtime `enqueueAgentMessage`. The enqueue wrapper rejects
  multi-user mode. The messaging resolver returns an alias/status, not the stable
  chat ID needed by the proposed binding contract.
- `runtime/src/channels/web/core/web-channel-runtime-public-surface-service.ts`:
  enqueue accepts `chatJid`, `content`, `mode`, returning queue/row/thread data where
  available. It has no durable caller-supplied idempotency key or per-review item
  completion receipt. Put a stable review/dispatch ID in the instruction text as
  well as add-on records; do not assume arbitrary metadata survives every path.

**Small generic host contracts required before implementation**

1. **Explorer action + pane launch.** `WorkspaceExplorer` currently has hardcoded
   selected-file menu actions; `__piclaw_web` exposes no action registrar or public
   openPane method. Propose `registerWorkspaceAction` (selected canonical path,
   metadata and trusted host invocation) and `openPane` (virtual path/label). Names
   are proposals. Show actions in the selected-file menu and accessible touch
   affordance; remove them if the add-on is unavailable. Do not patch explorer DOM
   or replace the normal editor. Integrate virtual paths with recents/reveal/save
   guards and unavailable-pane fallback as part of the same generic contract.
2. **Authorised local context + stable target resolution.** Expose a host-derived
   operator/access-mode context for authenticated actions and stable authorised
   chat identities for target pickers and agent-tool calls. A posted chat ID or
   model-supplied author name is not proof of authority. Single-operator v1 may use
   a host-established operator identity, but must fail closed in family/remote
   contexts. Never manufacture a peer principal or use pre-auth external routes.
3. **Activity subscription if absent.** A scoped, authenticated add-on notification
   stream or documented host event subscription is needed for agent replies and
   delivery changes. Use durable revision cursors plus refetch, not raw transient
   SSE as the database. Explicit refresh works before this exists; automatic
   updates need the real hook. Do not add hidden-pane polling to simulate it.

No private runtime imports. Settings contains only review preferences/limits; the
review itself is a pane. Bundle the add-on's browser modules at their declared
paths and consume public Preact globals if used. Implement a small read-only
line/hunk renderer in the add-on; do not borrow private CodeMirror instances.
Use Lezer syntax token roles compatible with Piclaw's editor and source preview.
The inspected `utils/code-highlighting.ts` exports helpers inside the host bundle,
not a public add-on API. Prefer exposing a small generic bounded highlighting API;
otherwise package explicit Lezer dependencies in the add-on. Do not import the
private core helper or dynamically load an editor merely to colour read-only text.
Keep visible context bounded and retain accessible line IDs across hunk expansion.

### Syntax highlighting contract

Tokenise each complete bounded source snapshot, and old/new diff snapshots
independently, before slicing results into displayed lines/hunks. A combined patch
is not a source document; parsing visible lines in isolation loses multiline
comments and strings. Use the path/language plus source digest and grammar version
as a bounded token-cache key. Paint existing `tok-*` classes with Piclaw's
`--syntax-*` variables (including distinct functions, definitions, types, strings,
booleans and numbers); map Lezer's `tok-string2` template strings to the string
role too. Theme changes repaint CSS without retokenising or moving
comments. Token spans never set background, padding, size or line height: 18px rows
and the green/red diff washes remain intact.

Escape every source fragment before wrapping it in spans. Preserve exact displayed
characters and line/side coordinates; highlighting must not affect copying or
anchors. Unknown languages, parser failure or an oversized snapshot fall back to
escaped plain text, with an honest language/plain-text indicator. Match the existing
96 KiB highlighting cap initially, independently of the larger review-file limit;
plain text stays reviewable. Don't guess a grammar for unknown extensions.

This mock precomputes Lezer classes for its synthetic TypeScript/Markdown examples
at build time and embeds escaped per-line fixtures, checking raw line equality
before using them. It supports plain-text fallback, not arbitrary runtime parsing.
No parser payload or network request is added to the page. Tests exercise multiline
comments/template strings, hostile source and theme role changes separately.

## Add-on-owned records

Store SQLite at `<getAddonDataDir('code-review')>/reviews.db`, with versioned
migrations, foreign keys and transactions. Add-on preferences may use extension KV;
SQLite is the source of review truth. Do not use the core messages DB as an annotation
store or write sidecars in reviewed repositories. Backups include the add-on data.

Identifiers below are opaque IDs. Every mutable record has `version`, `created_at`
and `updated_at`; ownership is inherited through the review and checked server-side.
Hash source bytes exactly (preserve encoding/newlines); compressed source blobs are
optional storage encoding, not a new content identity. The following is a logical
schema proposal, not a migration to run:

| Record | Essential fields | Purpose |
|---|---|---|
| `review` | id, owner_id, workspace_id, worktree_identity, title, entry_kind:file/diff, focus_path, default_target_id, lifecycle, version | Stable review container; repo identity nullable for Git-less files; worktree distinguished from common Git directory |
| `snapshot` | id, review_id, mode:source/unstaged/staged/commit, base/head object IDs, parent choice, captured_at, manifest_digest | Immutable capture of one review source/comparison; do not use moving branch names as identity |
| `snapshot_file` | id, snapshot_id, old/new path, change_kind, old/new blob hash, diff metadata | Multi-file membership, rename sides and exact comparison; caches hunks derived from these bytes |
| `source_blob` | workspace_id, sha256, encoding, byte_count, content | Original bounded saved bytes for historical context and re-anchoring; not browser state |
| `thread` | id, review_id, original_anchor, state:open/resolved/deleted, assignment_target_id, assignment_epoch, latest_resolution_event_id, version | Durable concern; immutable anchor and separate mutable thread state |
| `thread_projection` | thread_id, snapshot_file_id, side, range, status:exact/moved/ambiguous/missing, method, actor, version | Mapping onto another capture; cannot overwrite original anchor; manual remap is audited |
| `message` / `message_revision` | message_id, thread_id, author_kind/operator-or-agent, trusted author_id, ordinal, current_revision; revision body, edited_at/deleted_at | Ordered discussion and edits; delete purges bodies including stored revisions per deletion policy while retaining tombstones |
| `draft` | id, owner_id, review_id, thread_id or prospective anchor, body, acknowledged_version | Private durable comments/replies; never returned in agent thread reads |
| `dispatch` | id, review_id, author_id, target_chat_id, target_chat_incarnation, queue_mode, optional_summary, immutable payload_hash, state, version | One explicit send intent for one or many items; excludes draft/private content |
| `dispatch_item` | dispatch_id, ordinal, thread_id, sent_thread_version, message_revision references, assignment_epoch, snapshot_id, work_state, result_event_id | Captured selection with per-thread progress; deleted bodies never resurrected from a copied batch payload |
| `delivery_attempt` | id, dispatch_id, attempt_no, started_at, state:prepared/attempting/accepted/rejected/unknown, host_row_id, error_code | Host enqueue boundary; restart never blindly replays an ambiguous attempt |
| `review_event` | id/cursor, review_id, thread_id?, dispatch_id?, trusted actor, type, referenced versions, bounded payload | Resolution, reopen, reassignment, work progress and per-thread evidence; body-free delivery audit after deletion |
| `request_receipt` | owner_id, request_id, action, payload_hash, result_record_ids, expiry/retention | Mutation idempotency and conflict detection; responses cannot retain deleted comment bodies |

`target_chat_incarnation` means the durable chat identity lifetime, not a rotating
Pi session/context ID. Context rotation must preserve authorised assignment; alias
reuse after deletion must not. The host must expose enough identity information to
enforce that distinction, otherwise target selection fails closed.

Suggested indexes: review by owner/workspace; snapshot files by snapshot/path;
threads by review/state and anchor-file; messages by thread/ordinal; events by
review/cursor; dispatch items by thread and dispatch; unique attempt number per
dispatch; unique request receipt by owner/request ID. Logical records need not each
be a separate implementation class or service.

### Anchor representation

```ts
type OriginalAnchor = {
  snapshotFileId: string;
  scope: 'file' | 'range';
  side: 'source' | 'old' | 'new';
  startLine: number | null; // 1-based inclusive; both null for file scope
  endLine: number | null;
  blobSha256: string;
  selectedText: string; // bounded by selection limit
  contextBefore: string[];
  contextAfter: string[];
};
```

`file path + line number` is insufficient. Anchor to captured bytes and side; UI
row IDs and diff positions are never persisted as source coordinates. A unique
context match may make a new projection; duplicates produce Ambiguous. A recreated
file with the same path does not inherit trust automatically. Resolve stores the
thread version, snapshot and evidence at that moment; refresh cannot rewrite it.

### Three independent state dimensions

- **Thread:** open / resolved / deleted. Only explicit authorised thread actions
  change this; receipt success does not resolve a concern.
- **Delivery:** prepared / attempting / accepted / rejected / unknown. Accepted
  means the host took responsibility for queueing, not that an agent acted.
- **Item work:** not_started / in_progress / waiting_user / blocked / failed /
  completed / superseded. A batch may be partially completed; completed work does
  not require a resolved thread if the concern needs human discussion.

`Not sent` is derived from current published thread version versus dispatch items.
Editing sent guidance shows `Changed since send`; it never silently updates a
queued payload. Agent tools must re-read current state before acting and reject
stale resolution writes. Avoid one giant status enum mixing all three meanings.

## Service boundary and lifecycle

UI actions and agent tools share one review service with validated scope. Proposed
browser actions: create/open review, read snapshot/hunks, post/edit/delete message,
save draft, resolve/reopen/reassign, prepare/submit batch, inspect/retry
or reconcile delivery. Agent actions: list assigned batches, read authorised current
threads, reply, report item work, resolve with evidence. Agents receive IDs and a
bounded instruction to use these tools, not a repository dump or blanket authority.

Single-thread and batch send use the same path:

1. Validate owner, target, item versions, assignments and bounds in one transaction;
   persist dispatch/items + prepared attempt + idempotency receipt.
2. Claim the attempt once and mark attempting durably; call host enqueue outside
   the SQLite transaction with explicit `mode:'queue'`.
3. Persist acceptance/rejection if known. Crash/network ambiguity becomes unknown;
   repeated browser requests return the existing intent, not another host call.
4. The agent rechecks assignment and current thread state, then updates each item
   and replies through the same service. Show receipts even after the pane closes.

Notifications only invalidate cached data. On focus/reconnect fetch changes after
the last durable cursor; if the cursor is unavailable, refetch a bounded snapshot.
Close/dispose aborts fetches and removes listeners; queued agent work is independent.
Acknowledged drafts survive reopen. Unacknowledged drafts trigger the normal close
warning. Popout transfer carries review ID, active file and scroll/selection only;
a private draft body must not be encoded in a URL or entrusted solely to transfer.

## Implementation order after approval

1. Add the small generic host explorer/pane and trusted-context contracts with
   negative tests. Prove Review file on an unchanged Git file and a Git-less file.
2. Build the minimal add-on store and read-only file pane: immutable snapshots,
   anchors, persisted comment/reply CRUD and no agent execution.
3. Add staged/unstaged/commit comparisons, syntax highlighting, source refresh and
   projection; prove old-side deletions and renamed/outdated comments.
4. Add explicit single/batch queueing and scoped agent tools. Exercise busy agents,
   ambiguous delivery, partial results, restart and deletion races using fixtures.
5. Prove Classic/Visual and desktop/tablet/popout behaviour on a disposable host.
   No live installation or paid agent call is part of this design pass.

The accompanying HTML is a disposable interaction mock with synthetic code and
in-memory state. It demonstrates explorer file review, file/diff switching, inline
comments, selected batch submission and queued feedback. It does not implement
Piclaw routing, persistence, authentication or real agent delivery.
