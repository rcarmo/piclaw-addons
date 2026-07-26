# Late Night Regrets

Bayesian interaction-quality classification for Piclaw chat history. Requires Piclaw `>=2.1.0`.

## Install

Open **Settings → Add-Ons** and install **late-night-regrets** from the catalog.

## What ships

- `scripts/train-interaction-quality-bayes.ts` trains a weak-label Multinomial Naive Bayes model and writes classifier artifacts.
- `scripts/classify-recent.ts` classifies recent messages.
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
