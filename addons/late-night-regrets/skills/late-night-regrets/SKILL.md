---
name: late-night-regrets
description: Nightly Bayesian interaction-quality classifier — flags behavioral patterns from chat history and writes self-improvement reflections without spending model tokens on classification.
distribution: public
---

# Late Night Regrets

A lightweight, zero-token-cost interaction-quality classifier that runs nightly to identify behavioral patterns worth improving.

## What it does

1. **Trains** a Multinomial Naive Bayes classifier on the full chat message history
2. **Classifies** every user message that follows an agent turn into quality categories
3. **Flags** attention-worthy messages (corrections, misinterpretations, under-deliveries)
4. **Triggers** a short agent reflection pass that reads flagged messages, identifies patterns, and writes learnings to notes

## Categories

| Label | Meaning |
|---|---|
| `successful_execution` | Agent fulfilled the request correctly; user approved or moved on |
| `course_correction` | User had to steer, clarify, or redirect |
| `misinterpretation` | Agent misread intent; user explicitly corrected |
| `over_engineering` | Agent did too much; user asked to simplify |
| `under_delivery` | Agent gave too little; user pushed for more |
| `context_failure` | Agent forgot/lost context; user had to repeat |
| `good_proactive` | Agent anticipated a need; user approved |
| `neutral` | Normal flow, no strong signal |

## How classification works (no model tokens)

- Messages are tokenized (lowercased, code/URLs stripped, bigrams, structural features)
- Sequential context features: previous message sender, length, turn-pair detection, self-repetition ratio
- Weak labels derived from pattern matching on user follow-ups (approval words, correction phrases, repetition detection)
- Standard MNB training with 80/20 deterministic split
- Confidence-based filtering: only non-neutral predictions above threshold get flagged

## Nightly flow

The scheduled task runs at **02:30 UTC** (configurable):

```
1. bun run <addon>/scripts/train-interaction-quality-bayes.ts
   → retrains on full history, writes weights + predictions + attention file

2. Agent reads attention file, filters last 24h

3. For each flagged message:
   - Reads surrounding context from messages DB
   - Identifies what the user wanted vs what agent did

4. Writes patterns to notes/memory/interaction-reflections.md
   - Date, top patterns, behavioral adjustments
   
5. Appends new steering cues to notes/memory/feedback.md if warranted
```

## Manual trigger

```
/regrets
```

Runs the classifier and reflection pass immediately.

## Configuration

Settings → Late Night Regrets:

| Field | Default | Description |
|---|---|---|
| Enabled | `true` | Master switch |
| Cron schedule | `30 2 * * *` | When to run nightly |
| Confidence threshold | `0.55` | Minimum confidence for attention-worthy |
| Reflections path | `notes/memory/interaction-reflections.md` | Where learnings are written |
| Exports dir | `exports/interaction-quality` | Classifier artifacts |
| Recent hours | `24` | Window for the reflection pass |

## Artifacts

```
exports/interaction-quality/
  interaction-quality-weights-latest.json       # trained model weights
  interaction-quality-predictions-latest.jsonl  # all predictions
  interaction-quality-attention-latest.jsonl    # flagged messages only
  interaction-quality-report-latest.md          # human-readable report
```

## Design principles

- **Zero token cost for classification**: pure Bayes on bag-of-words + structural features
- **Sequential context matters**: features include prior message characteristics and self-repetition
- **Conservative flagging**: only high-confidence non-neutral predictions surface for reflection
- **Model tokens only for understanding**: the nightly agent pass reads a small set of flagged messages to extract *why*
- **Incremental improvement**: each night's reflection appends patterns; Dream consolidates over time
