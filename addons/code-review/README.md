# Code Review

Review saved source and Git diffs in Classic, keep inline discussions and private
drafts, and send selected concerns to a local agent. Source is read-only; posting
a comment does not start agent work.

The active release checklist is six Classic-only checks in
`specs/code-review/ACCEPTANCE.md`. The 184 older Gherkin IDs remain archived
design reference, not individual release gates. Run `bun addons/code-review/coverage.ts`
from the repository root for the compact checklist (`--legacy` includes the old
inventory). No checklist row passes merely because a test mentions its ID.
The agreed mockup's Classic layout, controls and interactions are still required;
the simplified checklist does not authorise UX deviations.

## Required host API

**Requires Classic on a Piclaw source build containing commit
`2a06652e9e82667e0a8117232476e87c86685935` (merged PR #1407, 25 September 2026)
or a later build retaining those APIs. The tagged v3.2.2 release does not contain
them.** Visual is not supported for this first release.

The pane feature-detects `__piclaw_web.workspaceActionsVersion === 1`; the backend
requires `__piclaw_runtime.localContext.version === 1` and host-verified submission
references. Its route is `piclaw://addon/code-review/<id>`. No numeric
`compatibleVersions` range is declared yet: the merged source and old tagged
release both identify as 3.2.2, so a numeric range would give a false guarantee.
Use the source-build requirement above until a tagged release contains these APIs.

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

`messaging.getAddonDataDir('code-review')/reviews.db` belongs to this add-on. Do not
point it at Piclaw's core message database. Snapshots and review records are
versioned; uninstall must retain the directory. Back up the SQLite database
consistently, including any WAL state. Destructive reset is not an implicit upgrade.

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

## Use and rollback

1. On a compatible Classic source build, install **Code Review** from Add-ons.
2. Select a saved file in the workspace and choose **Review file**.
3. Post comments, select the concerns to include, then explicitly **Send to agent**.
   One submission can include all selected concerns across multiple files.
4. To remove the add-on, use Add-ons → Uninstall, then restart when convenient.
   Its review database is retained. Reinstall the same version to reopen the work;
   do not delete or replace the store as part of rollback.

Installing/removing an add-on requires the normal host restart to load/unload it.
Do not reset the database or downgrade its schema. Back it up consistently before
upgrading the host or package.
