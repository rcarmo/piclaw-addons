---
name: cheapskate
description: Free-tier provider auto-rotation. Select cheapskate/auto as your model and it transparently routes to the best available free backend.
distribution: public
---

# Cheapskate Mode

Select `cheapskate/auto` from the model picker. It transparently routes requests to the best available free-tier backend and rotates on rate-limit errors.

## How it works

1. **Appears as a model** — `cheapskate/auto` shows up in the compose box model selector alongside your other models
2. **Shows the active backend** — the model name displays which provider is active: `Free → Google Gemini / Gemini 2.5 Flash · $0`
3. **Rotates automatically** — when a backend hits rate limits, it switches to the next available one before the next turn
4. **Costs nothing** — all backends are free-tier APIs

## Setup

Set API keys as environment variables or in the keychain (all are free to obtain):

| Provider | Env var / Keychain entry | Sign up |
|---|---|---|
| **Google Gemini** | `GOOGLE_GENERATIVE_AI_API_KEY` / `google/generative-ai-api-key` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Cerebras** | `CEREBRAS_API_KEY` / `cerebras/api-key` | [cloud.cerebras.ai](https://cloud.cerebras.ai/) |
| **Groq** | `GROQ_API_KEY` / `groq/api-key` | [console.groq.com/keys](https://console.groq.com/keys) |
| **SambaNova** | `SAMBANOVA_API_KEY` / `sambanova/api-key` | [cloud.sambanova.ai](https://cloud.sambanova.ai/) |

Only backends with a configured API key are available. Any subset works — even a single provider.

## Free-tier backends

| Provider | Model | Context | Reasoning | Free limits |
|---|---|---|---|---|
| **Google Gemini** | Gemini 2.5 Flash | 1M | ✅ | 10 RPM, 250K TPM, 1M TPD |
| **Cerebras** | Qwen 3 235B | 131K | ✅ | 30 RPM, 60K TPM, 1M TPD |
| **Groq** | QwQ 32B | 131K | ✅ | 30 RPM, 15K TPM, 500K TPD |
| **SambaNova** | DeepSeek R1 | 65K | ✅ | 10 RPM, 100K TPM |

## Usage

### Select the model

Pick `cheapskate/auto` from the model selector in the compose box or settings. The compose box shows the active backend:

```
cheapskate/auto — Free → Google Gemini / Gemini 2.5 Flash · $0
```

When the backend rotates (e.g. after a rate limit), the display updates:

```
cheapskate/auto — Free → Cerebras / Qwen 3 235B · $0
```

### Management tool: `cheapskate`

| Action | What it does |
|---|---|
| `cheapskate action=status` | Show configured/available backends and active backend |
| `cheapskate action=list` | List all backends with models, limits, and availability |
| `cheapskate action=usage` | Show current rate-limit consumption per backend |
| `cheapskate action=rotate` | Force rotation to the next available backend |

### Automatic rotation

- Before each turn: picks the best available backend (least recently used, then largest context)
- On rate-limit error (429): rotates to next backend with exponential backoff (30s → 5min max)
- At 90% of any limit (RPM/TPM/TPD): backend marked unavailable for rotation
- Tracking resets: per-minute counters reset every 60s, daily counters every 24h

## Quality ranking

| Use case | Best backend | Why |
|---|---|---|
| General coding | Google Gemini 2.5 Flash | Largest context (1M), strong reasoning |
| Complex reasoning | SambaNova DeepSeek R1, Groq QwQ 32B | Dedicated reasoning models |
| Fast iteration | Cerebras Qwen 3 235B | ~2000 tok/s inference speed |
| Budget fallback | Any — all are $0 | Rotate through all four |

## Notes

- Free tiers change frequently — backend definitions are hardcoded and should be updated when tiers change
- Quality varies between backends — Gemini 2.5 Flash and Cerebras Qwen 3 235B are the strongest for coding
- The extension uses `pi.registerProvider()` to register the `cheapskate` provider and `compat.modelId` to map the virtual `auto` model to the backend's actual model ID
- Each turn start re-registers the provider with the current best backend's URL and API key
- The tool is also available as a bundled extension in the piclaw monorepo for immediate availability without installing the addons package
