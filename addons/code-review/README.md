# Code Review — implementation in progress

Saved-source and Git-diff review with durable local discussions and explicitly
queued agent work. Source is read-only. This branch is not release-ready.

The active release checklist is six Classic-only checks in
`specs/code-review/ACCEPTANCE.md`. The 184 older Gherkin IDs remain archived
design reference, not individual release gates. Run `bun addons/code-review/coverage.ts`
from the repository root for the compact checklist (`--legacy` includes the old
inventory). No checklist row passes merely because a test mentions its ID.
The agreed mockup's Classic layout, controls and interactions are still required;
the simplified checklist does not authorise UX deviations.

## Required host API

Feature-detect `__piclaw_web.workspaceActionsVersion === 1` and
`__piclaw_runtime.localContext.version === 1`. Required localContext APIs and the
namespaced `piclaw://addon/code-review/<id>` route are being implemented in a
separate core worktree. The declared package compatibility is provisional until
that core change has a published version; do not publish this manifest as-is.

The host supplies trusted operator or explicit review-dispatch agent identity.
Ordinary legacy prompts, side/scheduled tasks and remote-origin turns do not gain
review authority from an ambient chat ID. Code Review requires the host-verified
`reference: {addonId, intentId}` for the current submission. Each Send may include
many concerns/files; another Send has separate review-tool scope even in the same
review/chat. The local host implementation and evidence are documented in
`specs/code-review/CR-079-HOST-CONTRACT.md`; its released core version is not yet
settled. If agent context is unavailable, use
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
It never installs or reloads the running instance. Classic acceptance beyond
the bounded checked slices is still required.

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
saved replies and drafts. Marker expiry and sign-out behaviour still need a
release decision; no source text or authority token is stored in the marker.

Install dependencies for this package using `bun install` in its directory. Source
capture uses safe Git argv and bounded UTF-8 regular-file reads. Syntax parsing
uses packaged Lezer dependencies and returns escaped plain text on unsupported or
large input. These capabilities remain subject to the acceptance/security gates.
