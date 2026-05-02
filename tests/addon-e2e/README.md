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

```bash
cd tests/addon-e2e
PICLAW_ADDON=sample-addon bun run test -- --project=desktop-chrome
bun run report
```

To prepare a temporary workspace installation path for the add-on:

```bash
PICLAW_WORKSPACE=$(mktemp -d) \
PICLAW_ADDON=sample-addon \
PICLAW_RUNTIME_ROOT=/path/to/piclaw/runtime \
bun run tests/addon-e2e/scripts/prepare-addon-test-instance.ts
```

The runner generates Playwright specs from Gherkin into `.generated/` and writes reports to:

```text
addons/<slug>/tests/reports/<slug>-ux-report.pdf
addons/<slug>/tests/reports/<slug>-ux-report.html
addons/<slug>/tests/reports/results.json
```

`build.ts` copies those reports into the GitHub Pages add-on page and includes them in the published tarball when present.
