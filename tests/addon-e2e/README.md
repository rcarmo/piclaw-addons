# Add-on UX E2E tests

This harness mirrors Piclaw's UX regression workflow for add-ons.

## Opt-in convention

An add-on opts in by adding Gherkin features under:

```text
addons/<slug>/tests/features/**/*.feature
```

Optional add-on-specific step definitions live under:

```text
addons/<slug>/tests/steps/**/*.ts
```

Shared steps are in `tests/addon-e2e/steps/`.

## Running locally

Start or prepare a Piclaw test instance with the target add-on installed, then run:

These tests can edit settings, upload files and post messages. Require an explicit disposable URL; a fresh browser alone does not isolate server-side state. Production internal-secret variables are not a fallback.

```bash
cd tests/addon-e2e
PICLAW_E2E_URL=http://127.0.0.1:9999 PICLAW_E2E_DISPOSABLE=1 \
PICLAW_E2E_INTERNAL_SECRET=<same-secret-as-the-test-instance> \
  PICLAW_ADDON=sample-addon \
  bun run test -- --project=desktop-chrome
bun run report
```

To prepare a temporary workspace installation path for the add-on:

```bash
PICLAW_ADDON=sample-addon \
PICLAW_RUNTIME_ROOT=/path/to/piclaw/runtime \
bun run tests/addon-e2e/scripts/prepare-addon-test-instance.ts
```

Preparation always creates its own temporary root and prints workspace, store, data, home and Pi-profile paths. It ignores inherited workspace paths. Use the printed paths for the disposable server and remove that owned root only after stopping it.

Preparation also prints XDG and temporary paths and copies dependencies into its owned root; it never links to writable host dependencies. Export the printed path fields, then start the runtime with `bun run scripts/run-test-instance.ts -- bun /path/to/piclaw/runtime/src/index.ts`. The wrapper validates the owner marker and every path and removes inherited service credentials. Supply only test-instance `PICLAW_E2E_INTERNAL_SECRET` and `PICLAW_E2E_KEYCHAIN_KEY` if needed; the wrapper maps them to runtime bootstrap variables.

The test run generates Playwright specs from Gherkin into `.generated/` and writes Playwright output to:

```text
tests/addon-e2e/reports/html
tests/addon-e2e/reports/results.json
```

`bun run report` then writes per-add-on reports to:

```text
addons/<slug>/tests/reports/<slug>-ux-report.pdf
addons/<slug>/tests/reports/<slug>-ux-report.html
addons/<slug>/tests/reports/results.json
```

`build.ts` copies those reports into the GitHub Pages add-on page and includes them in the published tarball when present.
