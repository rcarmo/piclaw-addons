# Code Review Classic fast pass — 24 September 2026

**Decision: no release or merge yet.** This checkpoint records what the isolated worktrees verified. It does not mark the 184 Gherkin scenarios accepted.

## Passed in owned disposable fixtures

- Authenticated Classic host: Explorer → Review file → comment → explicit Send → local loopback-provider reply and resolution → browser reload. Anonymous create/edit returned 401; authenticated foreign-origin create/edit returned 403. Forged identities/targets and hostile path, symlink and revision inputs did not create review or queue work.
- Pre-Send Classic browser HTTP requests in the fixture stayed on the loopback origin. The add-on had zero dispatch/attempt records and zero local-provider requests through browse and preview. This is fixture-scoped observation, not a general egress proof.
- The 19-file production tarball was extracted into an owned Classic host; dependencies were installed in that fixture. The authenticated loopback-provider flow passed with zero paid calls. Stopping and relaunching **only that fixture host** preserved the resolved conversation, accepted attempt and completed dispatch item. No live service was restarted.
- A later real Classic 390px keyboard run selected and posted a three-line range, kept dispatch counts unchanged and checked narrow drawer bounds. Escape initially bubbled to the host chat composer; the add-on now consumes Escape when dismissing its own drawer/menu and restores focus to Threads. Both source-copy and newly packed (54.31 KB) loopback-host checks pass. Forced-colour emulation showed source and Send visibility; screen-reader and full forced-colour audits are open.
- Add-on: 157 standard tests passed, one opt-in host test skipped in the standard suite; TypeScript check passed. A separate standalone copied-package import passed.
- Core worktree: 5,640 fast tests passed (7 skipped), 25 feature tests passed, and 9 web-build smoke tests passed in separate runs. The earlier combined `make ci-fast` did not return a final status after the test phase; these separate successes are not a clean combined CI result.
- CR-077, CR-078, CR-081 and CR-083 canonical step slices ran against the authenticated disposable Classic host. Other scenarios remain `acceptance: pending` in `coverage.ts`. CR-087 and CR-138 are now scoped to Classic; Visual was removed from active delivery by the operator.

## Gates requiring a decision or more work

1. **CR-079 host authority:** `localContext` v1 exposes chat identity, not the verified dispatch reference for the current prompt. Two reviews assigned to one chat are not isolated per prompt. See [CR-079-HOST-CONTRACT.md](CR-079-HOST-CONTRACT.md). The separately owned core contract needs explicit approval before implementation and same-chat cross-review tests.
2. **Core integration:** The core worktree has modified and untracked files. Host-contract review, an approved integration path, hosted CI and a final version providing the APIs are outstanding. The add-on manifest's `compatibleVersions: ">=3.2.1"` is provisional.
3. **Publication:** `bun run check:catalog` fails because the add-on has no generated catalogue/root-package entry. There is no published package or clean published-package install test. Do not publish the provisional package.
4. **Acceptance:** The remaining Gherkin steps, Classic accessibility/touch/zoom, migration/restored-host grant, long-idle/performance and platform gates are not verified. Group release-critical flows; do not use unit-test ID references as an acceptance count.
5. **Approval:** Merge, publication, live installation and live restart require separate explicit permission. The local `piclaw.service` was untouched.
