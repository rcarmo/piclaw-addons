# Code Review Classic fast pass — 24 September 2026

**Decision: no release or merge yet.** The active gate is [six Classic checks](ACCEPTANCE.md).
The results below are evidence for those checks; the old 184-scenario design is reference only.
The agreed mock's Classic UX is unchanged. Full visual/interaction parity has
not been signed off; the six-check simplification does not waive it.

## Latest checkpoint: author actions and catalogue lifecycle

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

1. **CR-079 host authority:** `localContext` v1 exposes chat identity, not the verified dispatch reference for the current prompt. Two reviews assigned to one chat are not isolated per prompt. See [CR-079-HOST-CONTRACT.md](CR-079-HOST-CONTRACT.md). The separately owned core contract needs explicit approval before implementation and same-chat cross-review tests.
2. **Core integration:** The core worktree has modified and untracked files. Host-contract review, an approved integration path, hosted CI and a final version providing the APIs are outstanding. The add-on manifest's `compatibleVersions: ">=3.2.1"` is provisional.
3. **Publication:** local `bun run check:catalog` passes with the 0.1.1 entry. The disposable manager installed the local tarball successfully, but there is no published-package install test. Do not publish until the compatible core version and security gates are settled.
4. **Acceptance:** Sign off the six active flows. Exhaustive permutations and follow-up depth are listed as deferred in [ACCEPTANCE.md](ACCEPTANCE.md); no 184-step-handler implementation is required. Existing security, persistence and no-implicit-send checks remain mandatory.
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
