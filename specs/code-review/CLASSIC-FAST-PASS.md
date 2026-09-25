# Code Review Classic fast pass — 24 September 2026

**Released: Code Review 0.1.4; all six checks pass for the documented Classic
source-build scope.** See [acceptance](ACCEPTANCE.md). The 184 older scenarios
remain design reference. The approved mock is unchanged.

## Follow-up interaction correction — 25 September

The published duplicate-send guard also blocked ordinary discussion replies when
work was waiting/blocked. The follow-up fix removes that incorrect restriction;
the older release results below did not cover this conversational loop.

- New operator replies/edits/deletions, reopen/reanchor and new overall instructions
  can create an explicit queued follow-up after accepted work in any work state.
  Agent-only replies do not make the same human guidance new. Same-request replay
  is idempotent; unchanged sends are refused without asking for reconciliation.
- Unknown delivery still requires a receipt decision, and prepared/attempting
  delivery waits for its result. Rejected retry/new-send races are guarded.
- A delivering follow-up supersedes access to its selected concerns for older
  submissions only. Unaffected batch items remain accessible; a definitely rejected
  follow-up does not revoke the prior accepted submission.
- Browser feedback distinguishes waiting, blocked, working, finished and unsent
  follow-ups. Overall-instruction edits refresh preview; final Send stays explicit.
- Twelve domain interaction tests and a browser answer-and-send test pass. Full
  suite: 181 pass, one opt-in skipped; strict TypeScript/catalogue checks pass.
  Packed 19-file 0.1.6 candidate passes 196 authenticated host assertions, including
  loopback agent work, busy queue, restart and catalogue reinstall. The full new
  conversational loop is exercised by the service-backed browser test, not the
  deterministic single-submission host provider.
- No live review records, receipts or service were changed. README documents the
  interaction rules. Independent read-only delegate timed out without findings.

## Public release verification

- Core #1407 merged at `2a06652e9`; add-on #144 merged at `2f621bb6`.
  Public artifact verification exposed the site builder ignoring the production
  files allowlist. Packaging fix #145 merged at `2e95327f`, advancing to 0.1.4.
  The builder now honours explicit files allowlists with `bun pm pack`, retains
  legacy exclusions for other packages, and fails on pack errors; four build
  tests pass and are included in CI.
- Public artifact:
  https://rcarmo.github.io/piclaw-addons/packages/piclaw-addon-code-review-0.1.4.tgz
- SHA-256: `05b1acd662d5bc6ed1cf7705f0d6fe6b4ed7bc2c278de4100c973d320a0c9e60`.
  Downloaded anonymously; contains exactly 19 production files without tests.
- The downloaded artifact passed the authenticated merged-core Classic fixture:
  **259 assertions in 97.0 seconds**, including local provider work, busy queue,
  actual catalogue install/remove/reinstall, cold restart, private drafts,
  tombstones/receipts, source/history/copy, phone/touch/keyboard and 65-second idle.
  Seven review-provider requests plus one prior busy request; zero paid calls.
- Hosted PR #145 checks passed; main workflows all succeeded: build/deploy
  `36125839400`, validation `36125839414`, archive publication `36125839424`,
  catalogue sync `36125839499`. Code Review regression suite: 166 pass, one
  opt-in skipped. Strict typecheck, standalone import and catalogue checks pass.
- README requires the merged Classic source build; tagged v3.2.2 is unsupported.
  No guessed future version or false semver range is declared. Rollback preserves
  the addon store. No live installation or service restart was performed.

## Earlier 25 September release candidate

- Core #1407 is merged at `2a06652e9e82667e0a8117232476e87c86685935`.
- Candidate 0.1.3 removes the false numeric compatibility range and documents the
  exact merged source requirement plus Classic APIs. Source main still reports
  3.2.2, while tagged v3.2.2 lacks the APIs; a semver range cannot distinguish them.
  No new core release is implied or required to test the known source build.
- Against merged `/workspace/piclaw`, the packed all-options authenticated host
  fixture passes 259 assertions in 97.4 seconds, including local provider work,
  busy queue, restart, actual catalogue uninstall/reinstall, retained records,
  phone/touch/copy/history and idle observation. Add-on regression: 166 pass,
  one opt-in skipped; typecheck and catalogue checks pass.
- The first merged-checkout browser run exposed an old ignored gzip sidecar in
  the core checkout. The test now copies current static assets to its owned
  fixture without compressed sidecars. Live/core checkout files were not changed.
- The README now has installation/use/rollback guidance, including preserving
  the review store. Review delegation timed out without results; it is not
  counted as independent review evidence.
- Add-on merge/publication and public-tarball verification are the remaining
  release steps. No live add-on installation or process restart is part of them.

## Earlier pull-request and hosted CI checkpoint

- Core PR: https://github.com/rcarmo/piclaw/pull/1407, branch
  `feat/addon-workspace-context`, head `de954e532`.
- Add-on draft PR: https://github.com/rcarmo/piclaw-addons/pull/144, branch
  `feat/code-review`. Both branches include current main via merge.
- Core hosted CI run `36069057362` passed in 6m40s: canonical fast CI,
  Chromium/WebKit SVG checks and isolated Git global-install smoke test.
  The previous run caught a generated-HTML merge error; restoring current main's
  marked theme bootstrap fixed it, and its two local regression tests passed.
- Add-on hosted validation run `36068434701` passed: Code Review regression and
  browser tests (166 pass, one opt-in skipped), metadata/Earendil checks, standalone
  imports and Remote Peer tests. Build run `36068434641` also passed. The dedicated
  Code Review CI job is now checked in.
- Packed 0.1.2 against the merged core branch passed the combined 259-assertion
  Classic fixture again in 96.1 seconds, including busy queueing and actual
  catalogue removal/reinstall. No paid provider calls or live service changes.
- Core integration is committed and pushed; neither PR is merged. The add-on PR
  stays draft until the core dependency is integrated and its actual release
  version replaces the provisional compatibility range. Publication and live
  installation/restart need separate approval. RC-6 is therefore still open.

## Earlier checkpoint: closer mock and separate submissions

- Open discussions on the current bounded source page expand automatically;
  explicit collapse is retained. Saved versions and thread filters are tucked
  into disclosures. Selection/target changes refresh the send preview automatically;
  old responses cannot overwrite the new selection or reopen a dismissed drawer.
  A stale-version rejection updates the preview but never sends again automatically.
- Fresh mock/implementation screenshots: `exports/code-review-mock-aligned/`.
  Browser comparison passes desktop/narrow source, diff, discussion and send
  states. Both use 12px/18px code rows and a 45px desktop toolbar; narrow bars
  measure 79px/78px without document overflow. The approved mock is unchanged.
- Separate-submission reference is bound and verified inside core. Code Review
  agent actions require it and expose only the selected concerns. Negative tests
  cover other submissions in the same review/chat, another review, forged IDs,
  absent references, stale assignment and reopen. A positive two-file batch
  reads, replies to and resolves all its selected concerns with one Send.
- Add-on regression: **166 pass, one opt-in skipped, 2,121 assertions**. Strict
  TypeScript, catalogue validation and diff whitespace check pass. The final
  19-file 0.1.2 tarball is 62.36 KB. Authenticated Classic all-options host test:
  **259 assertions pass in 110.4 seconds**, including queue-behind-busy, actual
  catalogue uninstall/reinstall, private-draft/receipt recovery, source/history,
  phone/touch/keyboard/copy, untrusted rendering and 65-second idle observation.
  Provider activity is seven review requests plus one held prior-work request,
  all loopback. No paid calls or live service changes.
- Core local validation: 5,641 fast tests pass (seven skipped), 25 feature tests
  pass, nine build-smoke tests pass, and typecheck passes. The `make ci-fast` tool
  wait timed out while its child test process continued; its fast-test log reached
  those passing totals. The remaining feature/build stages were then run separately
  and exited 0. This is not hosted CI or a single verified `make ci-fast` exit.
- Final focused core scope rerun: 12 tests / 111 assertions pass. The durable
  child-process case hit the default five-second timeout once; it now uses a
  bounded 15-second child/20-second test timeout with the same assertions.
- Independent judge delegation timed out without findings. Do not count that as
  completed review. At that checkpoint core integration was uncommitted; the
  later PR/CI result above supersedes that repository state. Release compatibility
  and approval to merge/publish/install remain RC-6 gates.

## Earlier checkpoint: author actions and catalogue lifecycle

- Author Edit/Delete controls follow PANE-DESIGN.md's overflow placement. Browser
  assertions cover 1280px/520px geometry, keyboard activation, Escape/focus return,
  edit persistence, cancelled/confirmed deletion, and zero dispatch from these
  actions. Screenshots: `exports/code-review-message-actions/`.
- Full regression: 165 tests pass (one opt-in host test skipped), 2,071 assertions;
  strict TypeScript passes. The final packed 0.1.1 authenticated Classic test
  passes **259 assertions in 100.4 seconds** with all previous options plus
  real catalogue uninstall/reinstall. RC-5 is passed for this supported flow.
- The fixture supplies an owned loopback catalogue/package URL to the real
  `/agent/addons/uninstall` and `/agent/addons/install` endpoints, boots without
  the package, then reinstalls and cold-boots it. Saved drafts, exact message
  history, tombstones, body-free receipts, and completed work survive without
  replay. Database/WAL bytes stay unchanged across the package-absent lifecycle.
  The same run includes busy queueing and 65-second idle observation.
- Local catalogue/root-package metadata now includes 0.1.1 and `check:catalog`
  passes. The public tarball URL is prospective: no package was published.
  Compatibility still depends on the unapproved core contract; no merge or live
  installation is authorised. Earlier entries below are historical checkpoints.

## Passed in owned disposable fixtures

- Authenticated Classic host: Explorer → Review file → comment → explicit Send → local loopback-provider reply and resolution → browser reload. Anonymous create/edit returned 401; authenticated foreign-origin create/edit returned 403. Forged identities/targets and hostile path, symlink and revision inputs did not create review or queue work.
- Pre-Send Classic browser HTTP requests in the fixture stayed on the loopback origin. The add-on had zero dispatch/attempt records and zero local-provider requests through browse and preview. This is fixture-scoped observation, not a general egress proof.
- The 19-file production tarball was extracted into an owned Classic host; dependencies were installed in that fixture. The authenticated loopback-provider flow passed with zero paid calls. Stopping and relaunching **only that fixture host** preserved the resolved conversation, accepted attempt and completed dispatch item. No live service was restarted.
- A later real Classic 390px keyboard run selected and posted a three-line range, kept dispatch counts unchanged and checked narrow drawer bounds. Escape initially bubbled to the host chat composer; the add-on now consumes Escape when dismissing its own drawer/menu and restores focus to Threads. Both source-copy and newly packed (54.31 KB) loopback-host checks pass. Forced-colour emulation showed source and Send visibility; screen-reader and full forced-colour audits are open.
- A grouped authenticated Classic host run selects a real Git file-history commit through the pane, captures an unstaged diff, and reads its bounded file rows. Source bytes, Git HEAD, dispatch count and provider-request count remain unchanged while browsing. The source-copy keyboard/history/diff/agent combination and the packed-tarball history/diff/agent combination pass; this does not cover all rename or long-history branches.
- A touch-enabled Classic browser can open at 1180px, resize the pane to 390px at 200% CSS zoom, and reach the source and thread drawer without an extra dispatch or provider request. A separate direct 390px touch-enabled browser enters via Classic's hamburger menu → Show workspace, opens the file and review pane, and sees source/Threads without an extra dispatch. The side tab computes to `display:none` when collapsed, but the menu provides a supported route. The earlier direct-phone blocker assessment was wrong; full touch accessibility remains open.
- The authenticated Classic pane stayed open for 65 seconds with no new Code Review API request, provider request or dispatch row, both before and after a completed loopback send. This does not establish hidden-pane, cancellation or long-duration performance budgets.
- A saved comment containing a script tag and unsafe `javascript:` URL rendered as text after explicit Refresh. No script ran or unsafe link appeared; a safe HTTPS link retained `noopener noreferrer`, and dispatch count stayed unchanged. Prompt-injection and all content variants are not covered.
- The authenticated Classic host copies selected source text without diff gutters, source mutation, extra review API/provider requests or cross-origin browser traffic. The pane has no thread-link export control; CR-090's public-share claim is not verified.
- Add-on: 165 standard tests passed, including bounded UX metadata and paired mock browser tests; one opt-in host test skipped in the standard suite. TypeScript check passed. A separate standalone copied-package import passed previously.
- Core worktree: canonical `make ci-fast` returned exit status **0** on 24 September at 19:42 UTC: 5,640 fast tests passed (7 skipped), 25 feature tests passed and 9 web-build smoke tests passed. The core worktree still contains modified and untracked files; this is local fast CI, not hosted CI.
- CR-077, CR-078, CR-081 and CR-083 step slices ran against the authenticated disposable Classic host. Their evidence contributes to the six active checks. The other legacy IDs are not a pending release counter. Visual is out of scope.
- The replacement page after fixture restart now answers the history prompt consistently and records Code Review requests for the idle check. The all-options packed Classic host run passes: phone entry, touch/zoom, keyboard, copy, untrusted rendering, history/diff, local-provider dispatch, restart and 65-second idle observation coexist in one fixture (195 assertions).
- The batched mock correction adds toolbar source modes, file +/−/open counts, old/new gutters, public author/snippet/path/delivery summaries and resolution evidence. The send drawer uses human-readable cards and a queue explanation; exact version IDs are expandable. Browser comparison measures matching 12px/18px code rows and 45px desktop toolbars, with paired desktop/narrow source/send/diff screenshots. Presentation differences still requiring approval are listed in [ACCEPTANCE.md](ACCEPTANCE.md).
- The final corrected source and metadata are in a 19-file, 59.45 KB packed tarball. The all-options authenticated Classic host run passes again with 195 assertions, including local-provider work, restart, source navigation and idle observation. Core and live service were not edited/restarted.

## Gates requiring a decision or more work

1. **Submission authority:** implemented and locally verified after approval; see [CR-079-HOST-CONTRACT.md](CR-079-HOST-CONTRACT.md). Core integration/review is still outstanding; this controls review tools, not ordinary file access or prior chat history.
2. **Core integration:** PR #1407 is committed, pushed and passes hosted CI. Merge/release approval and a final core version providing these APIs are outstanding. The add-on manifest's `compatibleVersions: ">=3.2.1"` is provisional.
3. **Publication:** local `bun run check:catalog` passes with the 0.1.2 entry. The disposable manager installed the local tarball successfully, but there is no published-package install test. Do not publish until the compatible core version and security gates are settled.
4. **Acceptance:** RC-1–RC-5 pass the supported Classic flows; RC-6 remains open. Exhaustive permutations and follow-up depth are listed as deferred in [ACCEPTANCE.md](ACCEPTANCE.md); no 184-step-handler implementation is required. Existing security, persistence and no-implicit-send checks remain mandatory.
5. **Approval:** Merge, publication, live installation and live restart require separate explicit permission. The local `piclaw.service` was untouched.

## Busy-target and recovery follow-up

At checkpoint `a1be0fc`, only test fixtures changed after `32a408b`; the
production implementation and paired mock screenshots were unchanged. The later
author-action changes and catalogue lifecycle results are listed above.

- Focused RC-3/RC-5 run: 22 tests, 354 assertions passed across batch, delivery,
  browser retry/reconcile, durability, draft-close and copied-store fixtures.
  Strict add-on TypeScript and `git diff --check` pass.
- Packed authenticated Classic with busy-target and recovery flags: 190
  assertions passed. A held earlier loopback turn is not interrupted by Send;
  the accepted review stays `not_started` until that turn finishes. Seven review
  provider requests then complete the work, plus one separate prior-work request.
  All requests use the owned loopback provider; no paid provider is configured.
- The acknowledged private draft restores through the real pane after cold
  restart and package absence/restoration. The exact public message history,
  deleted-reply tombstone and body-free receipt survive. The request has one
  receipt, and the dispatch still has one accepted attempt with completed work.
  Deleted revision bodies are absent. No browser/API recovery action resends.
- With the package absent, the database and WAL hashes remain unchanged across
  the disposable host boot/shutdown. The route rejects through the legacy host
  fallback (500, unknown command); no review/provider work runs. This is a manual
  package move/restore fixture, not catalogue-manager uninstall/install evidence.
- Final combined packed Classic run: **253 assertions passed in 94.6 seconds**.
  Busy-target, recovery, package absence/restoration, phone entry, touch/zoom,
  keyboard, clipboard, untrusted rendering, history/diff and 65-second idle
  checks coexist. The retained-data checks include WAL bytes and exact history,
  following read-only review. The six-check coverage-report tests also pass.

Reproduce the packed busy/recovery check from the add-on worktree, using a locally
packed tarball matching the current production files:

```sh
PICLAW_REVIEW_TEST_BROWSER=/workspace/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
PICLAW_REVIEW_CORE_SOURCE=/workspace/piclaw-worktrees/addon-workspace-context \
PICLAW_REVIEW_PACKAGE_TARBALL=/workspace/tmp/rcarmo-piclaw-addon-code-review-0.1.0.tgz \
PICLAW_REVIEW_HOST_TEST=1 PICLAW_REVIEW_AUTH_TEST=1 PICLAW_REVIEW_AGENT_TEST=1 \
PICLAW_REVIEW_BUSY_TEST=1 PICLAW_REVIEW_RESTART_TEST=1 PICLAW_REVIEW_RECOVERY_TEST=1 \
bun test addons/code-review/host.optional.test.ts
```

The tarball, browser and core paths are local fixture inputs, not published
compatibility claims. `PICLAW_REVIEW_IDLE_TEST=1` adds the 65-second idle check.
