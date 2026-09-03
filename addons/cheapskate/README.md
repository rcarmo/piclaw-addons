# Cheapskate

Cheapskate exposes one virtual model, `cheapskate/auto`, and routes each request through explicitly enabled models whose effective Piclaw/Pi catalogue price is exactly zero.

Requires Piclaw `>=2.15.3` because the add-on uses the shared model-registry interop bridge added for catalogue-backed routing.

## Install

Open **Settings → Add-Ons** and install **Cheapskate**. Open **Settings → Cheapskate** after the runtime reloads.

Cheapskate does not maintain its own provider or model catalogue. The Settings pane and request router read the same effective catalogue and authentication state as Piclaw. For `models.json` entries, cost is known only when that exact model definition explicitly declares all four rates; Pi's normalised zero defaults do not qualify as free.

## Zero-cost rule

A model is selectable only when all four base rates are finite and equal to zero:

- input;
- output;
- cache read;
- cache write.

Every optional input-pricing tier must also contain four finite zero rates and a valid threshold. Positive, missing, malformed and unknown costs fail closed. Custom models that omit `cost` are unknown even if Pi displays normalised zero rates. `cheapskate/*` is excluded to prevent recursion.

Provider marketing, trial credit and undocumented free quotas do not affect eligibility. A catalogue model with a positive price cannot be enabled in Cheapskate. If a zero-priced route reports a positive provider charge, Cheapskate quarantines it and shows a cost violation in Settings.

## Virtual and physical models

The normal model picker contains a single Cheapskate entry:

```text
cheapskate/auto
```

It is registered only when Cheapskate is enabled and at least one explicitly enabled zero-cost model has configured authentication. New catalogue models are disabled by default, so adding a provider or catalogue entry never opts the user in silently.

Assistant messages retain the virtual identity `cheapskate/auto`. The physical route is recorded as canonical `provider/model` in `responseModel` and a `cheapskate.route` diagnostic. This keeps session attribution and same-model overflow handling stable while preserving route visibility.

## Settings pane

**Settings → Cheapskate** lists only exact-zero catalogue models. The pane:

- groups models by provider;
- filters by model text and provider;
- separates `Eligible now`, `Needs credentials`, `Disabled`, `Excluded by session scope` and unhealthy states;
- shows catalogue-derived context, output, reasoning and image capabilities;
- enables or disables individual models;
- sets explicit route priority;
- shows the active physical route, cooldowns and the last classified error;
- explains why `cheapskate/auto` is unavailable.

Paid and unknown-cost entries are counted for diagnostics but omitted from the selectable list.

Credential setup remains provider-owned. Configure credentials with Piclaw's normal provider login/keychain flow, then reload or restart when that provider requires it. Cheapskate does not collect a duplicated table of provider keys.

## Eligibility and request filtering

Before each request Cheapskate applies all of these checks:

1. exact-zero catalogue price;
2. provider authentication and current availability;
3. explicit provider/model enablement;
4. the current session's scoped-model policy;
5. circuit/cooldown health;
6. text or image input support;
7. estimated context capacity;
8. requested output capacity.

An empty scoped-model list means Pi has no model scope and all available catalogue models may be considered. A non-empty scope is authoritative.

The virtual model advertises the safe capability intersection of enabled candidates. Request-time filtering applies the exact physical model limits.

## Selection and failover

Cheapskate uses request-local candidate snapshots. It prefers the last successful route for the same session to preserve provider cache affinity, then follows the explicit Settings priority and deterministic catalogue order.

Failover is bounded to three physical attempts. A different eligible route may be tried for:

- rate limits;
- selected transient network/server failures;
- missing models caused by catalogue drift;
- credential faults when another configured candidate exists;
- context mismatch when a larger eligible model exists.

Provider `Retry-After` and recognised rate-limit reset headers set bounded cooldowns. Cheapskate never replays a request after text, thinking content or a tool call has been emitted, because replay could duplicate user-visible text or tool side effects. Provider adapters also receive `maxRetries: 0` so one request has one visible retry policy.

Route preference is session-local. Health can be shared by physical model, but request attribution is immutable and concurrent chats cannot overwrite one another's route.

## Configuration and migration

Non-secret configuration uses global extension KV storage under extension ID `cheapskate`:

- global enablement;
- provider enablement;
- model enablement;
- ordered model priority.

Version 1 provider enablement stored under `backends` migrates by provider ID. Stale model IDs and token safety-cap fields are not mapped. Legacy `.pi/cheapskate.json` is imported once when no KV config exists.

Newly discovered zero-cost models remain disabled until selected in Settings.

## Management tool

The `cheapskate` tool supports the existing action names for compatibility:

| Action | Behaviour |
|---|---|
| `status` | Reports zero-cost candidate and eligible counts, active route and empty-state reason. |
| `list` | Lists catalogue-zero candidates and their current state. |
| `usage` | Explains that invented RPM/TPM/day counters were removed and returns current health details. |
| `rotate` | Directs the user to change request priority in Settings; routing is request-local. |

The add-on no longer claims provider quota limits it cannot verify.

## Failure states

Cheapskate classifies credential, missing-model, rate-limit, context, transient and permanent failures separately. Credential and missing-model faults remain quarantined until configuration/catalogue state changes. Rate-limit and transient faults use bounded cooldowns. A failed request returns the final mapped assistant error when no eligible route remains.
