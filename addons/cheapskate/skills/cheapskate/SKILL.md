---
name: cheapskate
description: Inspect and use the catalogue-backed cheapskate/auto router, which permits only explicitly enabled models with exact zero catalogue pricing.
distribution: public
---

# Cheapskate

Select `cheapskate/auto` from the model picker to route through explicitly enabled models whose effective Piclaw/Pi catalogue costs are all exactly zero.

## Eligibility

A physical model is eligible only when:

- the effective catalogue contains it;
- input, output, cache-read and cache-write base rates are finite zero values;
- every optional price tier also has four finite zero rates;
- its provider has configured authentication and the model is currently available;
- Settings enables the provider and model;
- the current session model scope permits it;
- its input, context and output capabilities fit the request;
- it has no active health quarantine or cooldown.

Positive, missing, malformed and unknown price metadata fails closed. A `models.json` model that omits `cost` remains unknown even when Pi normalises its displayed rates to zero. Trial credit and provider marketing do not make a positive-price model eligible. Newly discovered zero-cost models are disabled until the user enables them.

## Identity

The session model remains:

```text
cheapskate/auto
```

The final assistant message records the physical `provider/model` in `responseModel` and in a `cheapskate.route` diagnostic. Use those fields when reporting which route handled a request.

## Settings

Open **Settings → Cheapskate** to:

- filter exact-zero candidates by text or provider;
- inspect catalogue-derived context, output, reasoning and image support;
- enable or disable models;
- set route priority;
- view active route, health, cooldown and last error;
- see why the virtual model is unavailable.

Configure provider credentials through Piclaw's normal login/keychain flow. The pane does not maintain its own credential catalogue.

## Failover

Cheapskate tries at most three physical routes. It may retry a transient failure only before text, thinking or tool-call output has been emitted. It never replays after output begins because that can duplicate content or tool effects.

The router respects provider `Retry-After` and recognised rate-limit reset headers. It uses a bounded fallback cooldown when headers are absent. Route preference is session-local and concurrent chats retain request-local attribution.

## Management tool

| Action | Behaviour |
|---|---|
| `cheapskate action=status` | Show candidate/eligible counts, active route and empty-state reason. |
| `cheapskate action=list` | List catalogue-zero models and current eligibility state. |
| `cheapskate action=usage` | Return health details; fabricated provider quota counters are not used. |
| `cheapskate action=rotate` | Explain how to change explicit priority in Settings. |

If a supposedly zero-cost model reports a positive provider charge, Cheapskate quarantines it and exposes a cost violation in Settings. Do not bypass that quarantine by choosing the physical model through Cheapskate.
