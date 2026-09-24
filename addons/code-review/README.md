# Code Review — implementation in progress

Saved-source and Git-diff review with durable local discussions and explicitly
queued agent work. Source is read-only. This branch is not release-ready.

The approved design and 184 Gherkin scenarios are under `specs/code-review/` in the
repository. Implemented tests are tracked separately; a unit-test name mentioning
an ID does not imply that its whole acceptance scenario has passed.

## Required host API

Feature-detect `__piclaw_web.workspaceActionsVersion === 1` and
`__piclaw_runtime.localContext.version === 1`. Required localContext APIs and the
namespaced `piclaw://addon/code-review/<id>` route are being implemented in a
separate core worktree. The declared package compatibility is provisional until
that core change has a published version; do not publish this manifest as-is.

The host supplies trusted operator or explicit review-dispatch agent identity.
Ordinary legacy prompts, side/scheduled tasks and remote-origin turns do not gain
review authority from an ambient chat ID. If agent context is unavailable, use
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
`PICLAW_REVIEW_AGENT_TEST=1` uses a deterministic local provider. It never
installs or reloads the running instance. Full scenario and UI matrix coverage
is still required.

Agent `thread` reads compare the bounded current saved file against the original
anchor side. The `currentSource` status is observational and may be `unverified`
for Git/index/commit snapshots without a saved-file identity. It returns no
current source text or digest; use ordinary authorised source tools to inspect
changed code. The original anchor, saved bytes and history remain unchanged.

Install dependencies for this package using `bun install` in its directory. Source
capture uses safe Git argv and bounded UTF-8 regular-file reads. Syntax parsing
uses packaged Lezer dependencies and returns escaped plain text on unsupported or
large input. These capabilities remain subject to the acceptance/security gates.
