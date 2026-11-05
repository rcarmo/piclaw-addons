# Pi 1.2.0 qualification

Target the published 1.2.0 package family, coordinated with the core qualification branch. Root development dependencies and overrides pin the family exactly; adopter peer ranges remain compatible. No production deployment is part of this change.

## Compatibility change

`skill-model-effort` 0.1.4 handles the new `before_agent_start` user/custom union. Custom starts refresh the skill map without accessing a nonexistent prompt. Legacy user events and the new discriminated user events retain prompt matching. Other reviewed add-on handlers use common event fields.

The standard MCP wrapper remains selected. Native MCP replacement and unpublished upstream fixes are not included.

## Results

- Compatibility suite: 309 passed, 15 existing opt-in skips, zero failures.
- Five compatibility TypeScript projects passed.
- Standalone imports: all 31 passed with real dependency installation.
- Publication/build/catalog/isolation checks: 24 passed.
- Browser checks: 58 passed, 1,160 assertions, using disposable Classic/Visual/legacy Settings hosts from the qualified 1.2.0 core checkout.
- Current packaged Delegate CLI qualification derives its exact target from the root pin. Historical version-specific fixtures remain historical evidence.

The 15 compatibility skips comprise four A2A browser cases (run separately in the browser batch), three independent Python SDK/JWS gates, one opt-in real core-host integration and seven historical CLI/auth cases. Skips are not successful tests.

## Test corrections

A2A idle-disable tests wait for durable delivery settlement and dispatcher idle before asserting no additional posts. Separate in-flight shutdown coverage remains. Baseline testing reproduced the load-related failures; no Pi-specific A2A runtime regression was demonstrated.

The publication-isolation assertion now matches the existing fail-closed workflow; the old assertion also failed on the unchanged baseline. Standalone installs reuse cache and have a bounded timeout without bypassing dependency installation.

## Integration boundaries

Core qualification on the test VM used real Pi 1.2.0 SDK/CLI, a disposable stdio MCP server and five synthetic file-backed credential lifecycle cases. The tested installed wrapper reports 2.31.0 but differs from the npm archive of that version; that evidence does not qualify pristine npm-wrapper bytes. It does not establish live OAuth/account refresh or production deployment behaviour.

An independent source judge found no blocking issue. Preserve exact-head hosted receipts with the PR. No installed packages, credentials, settings or service state on production were changed during this qualification.
