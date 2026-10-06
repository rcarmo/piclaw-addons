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

## Optional curated classifier tools

The standalone `scripts/train-curated.ts` and `scripts/classify-recent.ts` are
lab tools for the legacy eight-category classifier. They do not replace
`regrets_review`, its frozen context-v5 ranker, or the optional Settings-selected
decision model. Their `interaction-v2` weights are not compatible with the review
ranker. No scheduled training or candidate activation is added.

Reviewed input is private JSONL, for example:

```json
{"id":"example-1","split":"train","label_source":"reviewed","label":"neutral","state":{"target":{"speaker":"user","content":"continue"},"context":[{"speaker":"assistant","content":"Ready for the next step."}]}}
```

```bash
bun addons/late-night-regrets/scripts/train-curated.ts \
  --input /private/reviewed-train.jsonl --output /private/new-candidate.json
bun addons/late-night-regrets/scripts/classify-recent.ts \
  --weights /private/new-candidate.json --out-dir /private/shadow-results
```

The trainer requires unique IDs, training-only splits and supported labels; it
refuses an existing output path. Labels still require human review: a nonempty
`label_source` is provenance, not proof of review. Keep holdout conversations and
repeated templates out of training, and evaluate category precision/recall and
benign-continuation false positives before any explicit activation. Scores are
not calibrated. Missing classes remain reported but cannot win predictions.

Curated inference neutralises structured restart handoffs and bare continuations;
textual relay/goal prefixes are learned features, not suppression authority.
Explicit complaints such as “continue, you forgot the tests” remain eligible.
Only the five failure categories enter the curated attention file.

The weak-label trainer will not overwrite versioned curated classifier weights.
Pause and drain any weak-label training job before explicit activation: these
standalone scripts do not provide an activation lock. Keep old weights and deploy
the matching reader first. Never put these weights at the context-v5 review-ranker
path. These commands are opt-in and do not make model calls themselves.
