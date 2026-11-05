# Add-on Settings input audit — 19 September 2026

The original audit covered the fourteen panes listed in `settings-inputs.test.ts`.
After A2A retirement, thirteen of those panes remain. Current registration discovery
also finds Code Review, Late Night Regrets and Restic, which the original list
omitted. Reconstructing the check at the pre-retirement revision produces the same
three omissions. Their coverage needs a separate follow-up; this dated report does
not qualify every currently registered pane. File viewers, editors and toolbar
widgets are outside this audit.

## Findings and releases

Sample Addon, Delegate and Remote Peer already used the shared field contract;
they are verified without a new release. Eleven panes needed changes:

- Portainer 0.1.9 and Proxmox 0.1.10: remove inline input shells and fixed label/help
  offsets; preserve config blur-save and keychain-only token handling.
- Observability 0.1.17: same field migration, including numeric text inputs;
  preserve conversion, config patches and connection-string storage.
- Vent 0.1.4 and Goal 0.1.48: field stacks replace fixed-width label rows;
  preserve path blur-save, goal scope, budgets and lifecycle action payloads.
- Telegram 0.1.3 and WhatsApp 0.1.4: labelled controls replace hard-coded
  background/border/font/width values; config and secret APIs unchanged.
- IMAP 0.1.11: label/ID associations and shared control shells, with a wrapping
  password/status group; account and keychain mutation helpers unchanged.
- Cheapskate 0.5.2: shared search/select fields; model/provider filters and
  prioritisation unchanged. Native booleans and priority buttons stay separate.
- Linkr 0.1.1: shared profile fields; fix default-export-only registration to
  side-effect `component` registration and add a named SVG navigation icon.
  Old standalone fixture used `render`, hiding the real host mismatch. The
  phone test now navigates from General through the visible Linkr tab.
  JSON parsing, reviewed-enable confirmation, explicit disable and grants unchanged.

Every migrated package contains its own `web/settings-fields.ts`, imported with
that exact `.ts` path. The host transpiles individual assets and does not resolve
missing `.js` imports. A CSS layer scoped to `data-settings-addon` supplies a
readable fallback for older supported hosts; unlayered host styles win. No core
styles or compatibility floors are changed.

## Appearance contract

Fields match the real core General input in their own skin for computed padding,
border width, radius, font size, background and text colour. Classic and Visual
retain their different geometry. Checkbox/radio/button roles are not rewritten.
Labels are associated, fields fit the content viewport, and help no longer uses
fixed left margins. Focus, disabled, readonly and invalid states use host rules.
No production settings are saved merely by loading or inspecting a pane.

## Validation

- Explicit browser matrix: **380 passed / 14,826 assertions**.
  Four widths: 1366, 820, 520 and 390;
  Classic, Visual and legacy/no-host fixture; light and dark.
- Matrix comprises 336 appearance cases, 28 native-state cases, 13 save/secret/
  confirmation cases, one Linkr phone navigation case and two inventory/asset checks.
- Broad repository suite: **624 passed, 408 opt-in tests skipped, zero failures**.
  The audit's opt-in browser cases are run separately; the remaining skips are
  unrelated integration fixtures. No blanket claim of running every optional test.
- Compatibility suite: **213 passed, 8 explicit integrations skipped**.
- Existing Sample/Delegate/Remote Peer browser regressions: **22 passed**.
- Strict compatibility and Linkr typechecks; catalogue sync, whitespace and
  all eleven package dry-runs passed.

An initial broad run failed because the isolated worktree lacked Observability's
runtime dependencies. Installing its declared dependencies resolved that fixture
setup issue; the subsequent broad run passed. No dependency manifest changes.

```sh
bun install --frozen-lockfile
bun install --cwd addons/observability --omit peer --ignore-scripts
bun run typecheck:earendil-compat
bun test --max-concurrency=1
PICLAW_E2E_DISPOSABLE=1 PICLAW_SETTINGS_CORE_SOURCE=/absolute/path/to/piclaw \
PLAYWRIGHT_BROWSERS_PATH=/absolute/path/to/ms-playwright \
  bun test --timeout 15000 settings-inputs.test.ts
```

Browser fixtures use actual Settings hosts, exact-path unbundled add-on assets,
mock APIs and temporary state. No provider/device requests, live credentials,
production installation, network enablement or restart. Optional screenshots use
an explicit `PICLAW_SETTINGS_AUDIT_SCREENSHOTS` output directory. Merge and
deployment remain separate operator actions.
