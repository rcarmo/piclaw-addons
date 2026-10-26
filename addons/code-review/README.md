# Code Review

Review saved source and Git diffs in Classic, keep inline discussions and private
drafts, and send new or updated discussions to a local agent. Source is read-only;
posting a comment does not start agent work.

![Code Review showing named authors, avatars and inline discussion](docs/code-review-discussion.png)

*Classic pane, rendered from the real add-on with disposable sample source and
profiles. The screenshot uses no live review data.*

## Review and send

- Choose **Review file** from the workspace explorer. Git is optional; unchanged
  saved files are supported alongside staged, unstaged and commit comparisons.
- Messages and thread summaries show the configured operator/agent name and
  avatar. Agent handles are resolved by the stored author's identity, not the
  thread's current assignment. Missing profiles/images fall back to labels/initials.
- Post comments and replies normally. **Send to agent** automatically discovers
  open, new or updated discussions for the chosen agent; there are no inclusion
  checkboxes. Review the preview and confirm to queue a batch of up to 50 threads.
  Additional discussions can be sent in a later batch. Private drafts are excluded.
- **Unsent** includes new operator guidance since the last send; agent replies alone
  do not create another send. A follow-up queues behind already accepted work.
  In-flight or uncertain delivery must finish or be reconciled first. Other targets
  are not silently reassigned.
- Resolve your own discussion with one click, or reopen it without sending work.
  Agent resolutions still require an explanation and valid source mapping.
- Delivery status stays beside the discussion: **Queued**, **Failed**, or
  **Delivery uncertain**. There is no receipts pane. Uncertain sends have an
  explicit **Check delivery** action; they are never replayed automatically.

## Manage saved reviews

Open **Settings → Add-ons → Code Review** for the Reviews list. **Open** uses the
stored review ID and snapshots, so it works after the source file is renamed or
deleted. Closing a review tab only closes its pane.

**Delete** permanently removes that review's messages, revisions, private drafts,
snapshots and stored source bytes from the active add-on database. Source files are
never deleted. Confirmation is required; an in-flight send must finish first.
Already accepted work cannot be recalled, but subsequent review-tool reads/writes
fail once the review is deleted. Minimal body-free request tombstones prevent
old requests from recreating it. Backups and already-delivered instructions are
not erased; this is logical deletion, not a forensic purge of SQLite pages.

**Automatically delete reviews older than N days** is off by default. Enable it
with confirmation and a whole number from 1 to 3650 days. Age means time since
last review activity, including recent drafts. The add-on checks hourly after a
verified workspace context has been seen, and when Settings refreshes, deleting
up to 100 old reviews per pass. The saved policy survives restart. Queued, running
and uncertain work is skipped; inactive unsent discussions can expire under this
policy. Reviews in another workspace are never selected by the cleanup pass.

The active release checklist is six Classic-only checks in
`specs/code-review/ACCEPTANCE.md`. The 184 older Gherkin IDs remain archived
design reference, not individual release gates. Run `bun addons/code-review/coverage.ts`
from the repository root for the compact checklist (`--legacy` includes the old
inventory). No checklist row passes merely because a test mentions its ID.
The agreed mockup's Classic layout, controls and interactions are still required;
the simplified checklist does not authorise UX deviations.

## Required host API

**Requires Piclaw 3.2.3 or later, using Classic.** Version 3.2.3 is the first tagged
release containing the required add-on APIs from PR #1407. Version 3.2.2 does not
contain them. Visual is not supported for this release.

The pane feature-detects `__piclaw_web.workspaceActionsVersion === 1`; the backend
requires `__piclaw_runtime.localContext.version === 1` and host-verified submission
references. Its route is `piclaw://addon/code-review/<id>`. The package declares
`compatibleVersions: ">=3.2.3"`; the packed add-on is tested against the tagged
3.2.3 source in a disposable authenticated host.

The host supplies trusted operator or explicit review-dispatch agent identity.
Ordinary legacy prompts, side/scheduled tasks and remote-origin turns do not gain
review authority from an ambient chat ID. Code Review requires the host-verified
`reference: {addonId, intentId}` for the current submission. Each Send may include
many concerns/files; another Send has separate review-tool scope even in the same
review/chat. The host implementation and evidence are documented in
`specs/code-review/CR-079-HOST-CONTRACT.md`. If agent context is unavailable, use
**Send to agent** from an authorised review. Direct API fields never establish
ownership. Browser actions are authenticated; there are no external peer routes.

## Storage

The add-on owns its review schema in both storage modes:

- The standalone host uses `messaging.getAddonDataDir('code-review')/reviews.db`.
  Keep this path separate from the core database.
- The native host explicitly calls `setReviewDatabaseSource({ database, assertOwner })`
  before opening a service. `ReviewDatabase.initializeBorrowed()` creates the
  `addon_code_review_*` namespace on that exact borrowed connection. The add-on
  never configures or closes the host connection or changes its `user_version`.
  Native mode must not fall back to the standalone path.

The shared schema has **16 regular tables and 6 explicit indexes**, plus SQLite's
own primary-key indexes. Its local marker is schema version 1. The definitions in
`database.ts` are byte-identical at the native-approved source
[`e8aac239`](https://github.com/rcarmo/piclaw-addons/blob/e8aac2399148cbef638764ba2b5a1cd916cc5ecc/addons/code-review/database.ts)
(package 0.1.8) and add-on source
[`8150ca59`](https://github.com/rcarmo/piclaw-addons/blob/8150ca59edb44d30d6a07557433f30612f71adc0/addons/code-review/database.ts)
(package 0.1.9): SHA-256 `18ea9fa1d0a5f7e215429d5fc563dcd166314e1ce8f96fe6a0350c93dabe6558`.
This schema equivalence does not approve a newer package for a native host that
pins another tool implementation or package version.

All shared tables below use the same add-on initializer. `ReviewStore` in
`store.ts` owns review mutations; `ReviewService` in `dispatch.ts` adds delivery
and recovery. Their payloads live in SQLite. The `R` retention class means the
transactional `deleteReview()` path, invoked by an explicit operator deletion or
the scoped, opt-in expiry policy described above.

| Table | Writer and supported invariant | Payload and retention |
|---|---|---|
| `addon_code_review_schema` | `ReviewDatabase.initializeBorrowed`: local compatibility marker | Version only; retain while any namespace objects remain |
| `addon_code_review_reviews` | `ReviewStore.createFromCapture`, `setTarget`: owner/workspace and optimistic version | Title, target and timestamps; R |
| `addon_code_review_blobs` | `ReviewStore` snapshot capture: review-scoped content hash | Saved UTF-8 source bytes; R |
| `addon_code_review_snapshots` | `ReviewStore` capture/refresh: immutable source revision | Mode, base/head and digest; R |
| `addon_code_review_snapshot_files` | `ReviewStore` capture/refresh: ordered file identities and composite FKs | Paths and old/new blob references; R |
| `addon_code_review_threads` | `ReviewStore.createThread`, resolve/reopen/reassign/reanchor | Anchor, state, target, assignment epoch and version; R |
| `addon_code_review_projections` | `ReviewStore` projection/reanchor: mapping onto a saved snapshot | Projection and actor; R; retain manual mapping evidence |
| `addon_code_review_messages` | `ReviewStore` reply/edit/delete: stable authorship and ordinal | Metadata and latest revision pointer; R |
| `addon_code_review_message_revisions` | `ReviewStore` reply/edit/delete: version history | Bodies; explicit message/thread deletion also redacts old bodies; R |
| `addon_code_review_drafts` | `ReviewStore.saveDraft`/`deleteDraft`: private unsent work | Body and optional anchor; explicit draft deletion or R |
| `addon_code_review_dispatches` | `ReviewService.submit`: immutable confirmed batch | Target, summary and payload hash; R |
| `addon_code_review_dispatch_items` | `ReviewService.submit`/`updateWork`: exact submitted versions and per-concern progress | Epoch, file, ordinal and work state; R |
| `addon_code_review_attempts` | `ReviewService.deliver`/`recoverInterrupted`: delivery certainty | Attempt state, host row and error code; R; never replay an unknown send automatically |
| `addon_code_review_events` | `ReviewStore.event` and service mutations: ordered reconnect/change cursor | Event metadata; R |
| `addon_code_review_request_receipts` | `ReviewStore.mutation`/`purgeDeletedReviewReceipts`: same-key/hash replay | Result; retain body-free tombstones after R to prevent resurrection |
| `addon_code_review_review_settings` | `ReviewStore.saveSettings`: owner/workspace retention choice | Nullable retention days; retain across review deletion and deactivation |

All 16 tables support distinct current contracts; no unsupported or duplicate
persistence has been proved. Empty tables do not justify removal. Blobs avoid
copying source for every snapshot, revisions preserve edits, and dispatch receipts
separate uncertain host delivery from discussion progress. Native SDK tasks own
agent execution. The add-on's concern/work states do not establish task liveness.
The six indexes support owner lists, snapshot ordering, thread/draft lists,
dispatch lookup and event cursors; this work makes no storage-saving claim.

Closing a pane leaves the service and records intact. UI service reset closes
cached services but retains the native database grant. Backend deactivation
releases that grant, closes services and stops their hourly cleanup timers;
stale continuations cannot acquire a new incarnation's authority. Removing or
excluding the package from host discovery leaves the database unchanged.
Reinstalling the same supported schema reopens its records. Interrupted delivery
becomes `unknown`; it is not sent again. Existing active/uncertain work remains
ineligible for automatic expiry.

Schema installation and the additive version-1 settings initializer run only
when the add-on opens its store. Core schema inventories do not recreate optional
objects. Unknown shared schema versions fail transactionally; do not remove the
marker to force initialisation. Other malformed version-1 objects need schema
inspection/repair; the marker alone is not proof of full integrity. Restore a
matching consistent checkpoint when required, preserving the failed source.

There is no per-review archive/export-and-import command. Keep snapshots,
revisions, receipts and settings together in a consistent database backup.
Uninstall must retain the standalone directory or, for native storage, the host
snapshot containing this namespace. Use the host's coordinated backup mechanism;
copying only an open SQLite main file can omit committed WAL state. A complete
native recovery unit also needs the host's external payload/configuration
requirements. No reset, drop, retention schedule or live restore is implied here.

## Testing during development

From the repository root, retain the checked-in test preloads:

```sh
bun test addons/code-review
./node_modules/.bin/tsc --noEmit -p addons/code-review/tsconfig.json
```

The browser integration test creates its own ephemeral loopback server, database,
workspace, profile and fake queue adapter. `PICLAW_REVIEW_TEST_BROWSER` may name an
existing Chromium executable; it never names a target server. No paid provider or
live Piclaw instance is used. The opt-in `host.optional.test.ts` instead boots
a disposable Piclaw worktree with its own workspace, profile and SQLite store;
`PICLAW_REVIEW_AUTH_TEST=1` enables a fixture-only TOTP session, and
`PICLAW_REVIEW_AGENT_TEST=1` uses a deterministic local provider. Set
`PICLAW_REVIEW_PACKAGE_TARBALL` to a locally packed tarball to replace the
source-tree copy and install its production dependencies in that fixture.
It never installs or reloads the running instance. The acceptance ledger records
verified Classic flows and the platform/stress combinations not covered.

Agent `thread` reads compare the bounded current saved file against the original
anchor side. The `currentSource` status is observational and may be `unverified`
for Git/index/commit snapshots without a saved-file identity. It returns no
current source text or digest; use ordinary authorised source tools to inspect
changed code. The original anchor, saved bytes and history remain unchanged.

If a public reply commits but its response is lost, the pane stores only the
request, thread and optional draft identifiers in same-origin browser storage.
The pane offers explicit receipt reconciliation after reload or in another tab;
it never resends automatically. The server checks the current operator, actor,
review and thread before returning a body-free receipt. A missing receipt
retains the acknowledged draft. If the marker is unreadable, reply posting is
blocked until the operator confirms clearing that browser marker after checking
saved replies and drafts. The browser marker contains only identifiers and grants no authority; every
lookup requires a current authorised session. It is not automatically expired on
sign-out. Clear it explicitly from the pane after checking the saved reply.

Install dependencies for this package using `bun install` in its directory. Source
capture uses safe Git argv and bounded UTF-8 regular-file reads. Syntax parsing
uses packaged Lezer dependencies and returns escaped plain text on unsupported or
large input.

## Discussing and sending follow-ups

- **Post comment/reply** saves it without starting the agent. Drafts stay private;
  posted replies are public in the discussion. Use **Send** to request another turn.
- A saved reply, edited/deleted human message, reopened concern or changed anchor
  can be sent while earlier accepted work is queued, running, waiting, blocked or
  finished. A new non-empty overall instruction in the send drawer also counts.
  The follow-up queues behind current work; it never interrupts it.
- An unchanged send is blocked as already sent. Repeated requests with the same
  request ID reuse the original submission. A failed work item can be explicitly
  retried with a new Send without rewriting the guidance.
- When the host begins delivering the follow-up, it takes over only the selected
  concerns. An older submission cannot reply to or resolve those concerns, but
  keeps access to unaffected concerns in its batch. This cannot undo file work
  already performed by an earlier turn.
- **Delivery uncertain** means there is no reliable queue acknowledgement. Keep
  discussing, but use the thread's **Check delivery** action before sending again.
  **Failed** means a definite rejection: explicitly Send again when ready. Internal
  delivery records remain available for recovery; there is no receipts pane.
- Resolve does not mark agent work completed, and an agent finishing does not
  resolve a concern. Reopen is explicit and does not send. Reassignment is explicit
  and invalidates the previous assignment; preview rejects mixed-target batches.
- For a batch, **Send to agent** finds unsent discussions for the current target.
  You can also use **Send thread** for an explicit single-thread follow-up with a
  new overall instruction. The preview fixes the submitted versions; if guidance
  changes before confirmation, review the refreshed preview and confirm again.

The pane uses **Unsent**, **Queued**, **Failed**, and **Delivery uncertain**, with
agent work state shown separately. A persisted work state is not evidence that an
agent process is still running.

## Use and rollback

1. On Piclaw 3.2.3 or later in Classic, install **Code Review** from Add-ons.
2. Select a saved file in the workspace and choose **Review file**.
3. Post comments, then use **Send to agent** to preview new or updated discussions
   for that target. Confirming queues one submission across the included files.
4. To remove the add-on, use Add-ons → Uninstall, then restart when convenient.
   Its review database is retained. Reinstall the same version to reopen the work;
   do not delete or replace the store as part of rollback.

Installing/removing an add-on requires the normal host restart to load/unload it.
Do not reset the database or downgrade its schema. Back it up consistently before
upgrading the host or package.
