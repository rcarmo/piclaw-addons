# Late Night Regrets

Bayesian interaction-quality classification for Piclaw chat history. Requires Piclaw `>=2.1.0`.

## Install

Open **Settings → Add-Ons** and install **late-night-regrets** from the catalog.

## What ships

- `scripts/train-interaction-quality-bayes.ts` trains a weak-label Multinomial Naive Bayes model and writes classifier artifacts.
- `scripts/train-curated.ts` trains a candidate from reviewed JSONL without reading the live database or overwriting existing weights.
- `scripts/interaction-model.ts` shares context/provenance features between curated training and inference.
- `scripts/classify-recent.ts` classifies recent messages, supporting both legacy and versioned curated weights.
- `scripts/setup-nightly-task.ts` creates the optional scheduled agent task.
- the `late-night-regrets` skill guides the agent through classification and reflection.
- `/regrets` currently displays working/status feedback; it does not execute the classifier scripts itself.

The extension registers a direct config API but no browser settings pane. Saved config is available to the injected prompt; the scripts still take their own CLI parameters where documented.

## Classifier artifacts

By default, scripts write under `exports/interaction-quality/`:

- `interaction-quality-weights-latest.json`
- `interaction-quality-predictions-latest.jsonl`
- `interaction-quality-attention-latest.jsonl`
- `interaction-quality-report-latest.md`

Classification is mechanical and uses no model tokens. The optional scheduled agent task reads the flagged set and may append reflection notes through the normal agent workflow.

## Curated training

Use an authorised labelling tool such as `pi-decision` to propose labels from bounded, redacted context. Keep raw datasets private. Review disagreements and uncertain cases; model-generated confidence is not calibrated. Keep holdout IDs, conversation groups and repeated message templates out of training. Report failure-category precision/recall and benign-continuation false positives against the existing model, not agreement with weak rules alone.

Each reviewed input line has this shape:

```json
{"id":"example-1","split":"train","label_source":"reviewed","label":"neutral","state":{"target":{"speaker":"user","content":"continue"},"context":[{"speaker":"assistant","content":"Ready for the next step."}]}}
```

```bash
bun addons/late-night-regrets/scripts/train-curated.ts \
  --input /private/reviewed-train.jsonl --output /private/new-candidate.json
bun addons/late-night-regrets/scripts/classify-recent.ts \
  --weights /private/new-candidate.json --out-dir /private/shadow-results
```

The trainer rejects holdout/uncertain rows and existing output paths. Curated inference neutralises structured restart handoffs and bare continuations. Textual goal/relay prefixes are learned features, not trusted suppression authority. Explicit complaints such as “continue, you forgot the tests” still reach the classifier. Only the five failure categories enter the curated attention file. All eight categories remain in the model; missing training classes are reported by their zero counts, not silently invented.

Candidate activation is an explicit operation after evaluation. Pause and drain any weak-label training job before activation; the standalone scripts do not implement a shared activation lock. Preserve previous weights and deploy the matching versioned reader first. The weak-label trainer checks for curated weights both before training and before publishing; curate and validate a new candidate for later updates. Nightly inference remains local and makes no model calls.

## Schedule setup

Create the nightly task explicitly:

```bash
bun addons/late-night-regrets/scripts/setup-nightly-task.ts --cron '30 2 * * *'
```

Installing the add-on alone does not schedule a task.

## Categories

The classifier emits `successful_execution`, `course_correction`, `misinterpretation`, `over_engineering`, `under_delivery`, `context_failure`, `good_proactive`, or `neutral`.

## Development

```bash
bun addons/late-night-regrets/scripts/train-interaction-quality-bayes.ts
bun addons/late-night-regrets/scripts/train-interaction-quality-bayes.ts --recent-hours 48
bun test addons/late-night-regrets/index.test.ts
```
