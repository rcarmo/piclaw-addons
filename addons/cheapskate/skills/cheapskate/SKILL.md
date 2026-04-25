---
name: cheapskate
description: Rotate across free-tier AI providers to minimize API costs. Tracks rate limits and auto-switches when one provider is exhausted.
distribution: public
---

# Cheapskate Mode

Automatically rotates across free-tier AI providers to keep API costs at zero (or near-zero).

## How it works

The cheapskate extension:

1. **Registers free-tier providers** — Google Gemini, Cerebras, Groq, SambaNova (and others as they become available)
2. **Tracks rate limits** — per-minute request/token counts, daily token budgets, cooldown after errors
3. **Rotates on exhaustion** — when one provider hits its limits, switch to the next available one

## Setup

Set API keys as environment variables (all are free to obtain):

| Provider | Env var | Get a key |
|---|---|---|
| **Google Gemini** | `GOOGLE_GENERATIVE_AI_API_KEY` | [aistudio.google.com](https://aistudio.google.com/apikey) |
| **Cerebras** | `CEREBRAS_API_KEY` | [cloud.cerebras.ai](https://cloud.cerebras.ai/) |
| **Groq** | `GROQ_API_KEY` | [console.groq.com](https://console.groq.com/keys) |
| **SambaNova** | `SAMBANOVA_API_KEY` | [cloud.sambanova.ai](https://cloud.sambanova.ai/) |

Only providers with a configured API key are registered. You can use any subset.

## Available free-tier models

| Provider | Models | Context | Free limits |
|---|---|---|---|
| **Google Gemini** | Gemini 2.5 Flash, Flash-Lite | 1M | 10 RPM, 250K TPM, 1M TPD |
| **Cerebras** | Qwen 3 235B, Llama 4 Scout, Llama 3.1 8B | 131K | 30 RPM, 60K TPM, 1M TPD |
| **Groq** | Llama 4 Scout, QwQ 32B, Gemma 2 9B | 131K | 30 RPM, 15K TPM, 500K TPD |
| **SambaNova** | DeepSeek R1, QwQ 32B, Llama 3.3 70B | 65–131K | 10 RPM, 100K TPM |

## Usage

### Tool: `cheapskate`

| Action | What it does |
|---|---|
| `status` | Show how many providers are configured and available |
| `list` | List all providers with their models, limits, and availability |
| `usage` | Show current rate-limit consumption per provider |
| `rotate` | Switch to the next available free-tier provider/model |

### Manual rotation

```
cheapskate action=rotate
```

### Check what's available

```
cheapskate action=list
```

### Monitor usage

```
cheapskate action=usage
```

## Rate-limit handling

- Per-provider tracking of requests/minute, tokens/minute, tokens/day
- Providers at 90% of any limit are marked unavailable for rotation
- Errors trigger exponential backoff cooldown (30s → 60s → 120s → 5min max)
- Rotation picks the next available provider round-robin

## Notes

- Free tiers change frequently — the provider list is hardcoded and should be updated when tiers change
- Quality varies significantly between free models — Gemini 2.5 Flash and Cerebras Qwen 3 235B are the strongest
- Free tiers are best for routine tasks, research, and drafting — switch to a paid model for production-critical work
- The extension registers providers via `pi.registerProvider()`, so models appear in `list_models` output
