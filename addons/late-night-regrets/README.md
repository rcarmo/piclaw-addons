# Late Night Regrets

Budgeted daily review of human feedback, with an optional decision model selected in Settings. Requires Piclaw ≥3.2.3 in single-user mode; shared-user and isolated-container modes are rejected until an owner-aware history/model API is available.

The `regrets_review` tool includes every human exchange when the bounded input fits. On busy days it uses a local frozen Bayesian ranker plus a repeatable sample. The nightly agent reads the context and writes at most five supported lessons. One correction can matter; there is no minimum flag count.

## Settings

The direct API is `/agent/addons/api/late-night-regrets/config`; available model names come from `/models`. Both use the host's authenticated add-on API.

| Setting | Default | Behaviour |
|---|---|---|
| Enabled | true | Disabled reviews stop without writing notes |
| Review budget | 24,000 estimated tokens | Serialised packet cutoff (UTF-8 bytes / 3), not billed usage |
| Decision model | Off | Optional one-call contextual triage; exact provider/model selection |
| Recent hours | 24 | All chats by default; current-chat option in Settings |
| Reflections path | `notes/memory/interaction-reflections.md` | Nightly agent writes supported patterns |
| Exports directory | `exports/interaction-quality` | Optional private ranker location |

Schedule metadata remains available through the config API. Saving it does not alter an existing scheduled task. `confidence_threshold` is retained for legacy clients; it does not gate the new review packet.

## Input and decisions

The default scope preserves the old nightly all-chat coverage on single-user instances. Each exchange carries its chat ID; context never crosses chat boundaries. The builder retains short human messages, excludes recognised automation and peer envelopes, bounds code/logs and text, includes six preceding and two following meaningful same-chat messages, and follows up to three prior explicit message references plus a thread root. Following context stops at the frozen window end. Erased messages are never included; references cannot fetch another chat's context.

The optional model returns `review`, `routine` or `uncertain` for each selected target. Its output cannot remove exchanges, write notes or run tools. Invalid output, timeout or unavailable models return the same packet for normal review. Calls have a 60-second deadline, no retries and no alternate-provider fallback. Available usage is returned through the tool; failed calls may still incur cost. Excerpts remain sensitive despite common-secret redaction.

Overflow uses 80% of the input budget for ranking and the remaining space for a deterministic sample. Supply private context-v5 weights at `exports/interaction-quality/interaction-quality-review-ranker.json`; without them, the builder reports `sample_only`. No private training texts or derived vocabulary are shipped in this package.

## Run

- `/regrets`: ask the current agent to run the reflection.
- `scripts/setup-nightly-task.ts`: explicitly update/create the current-chat nightly task after installing the add-on. This writes task configuration; it is not run by installation or Settings.
- `scripts/build-review.ts --db PATH --chat JID --end ISO --compare`: read-only cutoff comparison, counts and row IDs only.

The old classifier and training scripts remain for explicit diagnostics. Nightly reflection never trains automatically.

## Validation

```sh
bun test addons/late-night-regrets
bun run check:catalog
```

Tests use disposable SQLite databases, fake model responses and the repository isolation preload. Browser validation mounts the real Settings component with a local fixture API, never the live instance.
