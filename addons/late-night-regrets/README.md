# piclaw-addon-late-night-regrets

> *"What did I get wrong today?"*

A nightly Bayesian interaction-quality classifier for [PiClaw](https://github.com/rcarmo/piclaw). Trains on chat history, flags behavioral patterns, and writes self-improvement reflections — without spending model tokens on classification.

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│                    Chat message history                           │
│  (SQLite: messages.db, all chats, all sessions)                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Multinomial Naive   │
                    │  Bayes classifier    │  ← zero model tokens
                    │  (weak-label trained)│
                    └──────────┬──────────┘
                               │
              ┌────────────────▼────────────────┐
              │     Attention-worthy messages     │
              │  (corrections, misinterpretations,│
              │   over-engineering, under-delivery,│
              │   context failures)                │
              └────────────────┬────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Agent reflection    │  ← model tokens here only
                    │  (reads context,     │
                    │   extracts patterns) │
                    └──────────┬──────────┘
                               │
              ┌────────────────▼────────────────┐
              │  notes/memory/interaction-       │
              │  reflections.md                  │
              │  notes/memory/feedback.md        │
              └─────────────────────────────────┘
```

## Installation

Open **Settings → Add-Ons** and install **late-night-regrets** from the catalog.

## Configuration

The settings pane exposes:

| Field | Default | Description |
|---|---|---|
| **Enabled** | `true` | Master switch |
| **Cron schedule** | `30 2 * * *` | Nightly run time (UTC) |
| **Confidence threshold** | `0.55` | Min confidence for attention-worthy |
| **Reflections path** | `notes/memory/interaction-reflections.md` | Output file |
| **Exports dir** | `exports/interaction-quality` | Classifier artifacts |
| **Recent hours** | `24` | Lookback window for each reflection |

## Categories

The classifier labels user messages that follow agent turns:

| Category | Signal |
|---|---|
| `successful_execution` | "perfect", "thanks", "exactly", short affirmatives |
| `course_correction` | "not that", "I meant", "try again", "to clarify" |
| `misinterpretation` | "wrong", "misunderstood", "that's not what I asked" |
| `over_engineering` | "too much", "simpler", "just do", "keep it simple" |
| `under_delivery` | "you forgot", "also need", "continue", "the rest" |
| `context_failure` | "I already said", "remember", high self-repetition |
| `good_proactive` | "good idea", "nice catch", "smart" |
| `neutral` | Normal flow, no strong signal |

## Commands

- `/regrets` — manually trigger a reflection pass

## Artifacts

After each run:

```
exports/interaction-quality/
├── interaction-quality-weights-latest.json
├── interaction-quality-predictions-latest.jsonl
├── interaction-quality-attention-latest.jsonl
└── interaction-quality-report-latest.md
```

## Design

- **Classification is free**: pure Naive Bayes on tokenized text + structural features
- **Sequential context**: features derived from the conversation flow (previous sender, message length, repetition)
- **Weak supervision**: no manual labeling needed — patterns are detected from the text
- **Model tokens only for insight**: the reflection pass uses model reasoning only on the small flagged set
- **Integrates with Dream**: reflection notes are in the standard memory hierarchy that Dream consolidates

## Development

```bash
# Run the classifier manually
bun run scripts/train-interaction-quality-bayes.ts

# Run with recent-only classification
bun run scripts/train-interaction-quality-bayes.ts --recent-hours 48

# Test
cd /workspace/piclaw-addons/addons/late-night-regrets && bun test
```

## License

MIT
