---
name: cheapskate
description: Free-tier provider auto-rotation. Select cheapskate/auto as your model and it transparently routes to the best available free backend.
distribution: public
---

# Cheapskate Mode

Select `cheapskate/auto` from the model picker. It transparently routes requests to the best available configured free-tier backend and rotates on rate-limit or context-limit errors.

## How it works

1. **Appears as a model** — `cheapskate/auto` shows up in the model selector alongside other models.
2. **Shows the active backend** — the model name displays the current route, such as `Free → Google Gemini / Gemini 2.5 Flash · $0`.
3. **Uses real active-backend metadata** — context window, max tokens, reasoning support, and input capabilities reflect the active backend, not a merged superset.
4. **Rotates automatically** — rate-limit and context-window failures switch to another available backend before later turns.
5. **Keeps costs at free-tier defaults** — usage tracking avoids configured free-tier limits and applies Cloudflare’s safety cap by default.

## Setup

Set API keys in **Settings → Cheapskate** or directly in the keychain. Restart the runtime after changing a key so its injected environment is rebuilt. Cloudflare also requires `CLOUDFLARE_ACCOUNT_ID`, which the pane does not collect.

| Provider | Env var / Keychain entry | Sign up |
|---|---|---|
| **Google Gemini** | `GOOGLE_GENERATIVE_AI_API_KEY` / `google/generative-ai-api-key` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Cerebras** | `CEREBRAS_API_KEY` / `cerebras/api-key` | [cloud.cerebras.ai](https://cloud.cerebras.ai/) |
| **Groq** | `GROQ_API_KEY` / `groq/api-key` | [console.groq.com/keys](https://console.groq.com/keys) |
| **SambaNova** | `SAMBANOVA_API_KEY` / `sambanova/api-key` | [cloud.sambanova.ai](https://cloud.sambanova.ai/) |
| **OpenRouter** | `OPENROUTER_API_KEY` / `openrouter/api-key` | [openrouter.ai](https://openrouter.ai/) |
| **OpenCode Zen** | `OPENCODE_API_KEY` / `opencode/api-key` | [opencode.ai](https://opencode.ai/) |
| **NVIDIA NIM** | `NVIDIA_API_KEY` / `nvidia/api-key` | [build.nvidia.com](https://build.nvidia.com/) |
| **Cloudflare Workers AI** | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` / `cloudflare/api-token` | [dash.cloudflare.com](https://dash.cloudflare.com/) |

Only backends with configured keys and enabled settings are available. Any subset works.

## Free-tier backends

| Provider | Model | Context | Input | Reasoning | Default free-tier guard |
|---|---|---:|---|---|---|
| **Google Gemini** | Gemini 2.5 Flash | 1M | text + image | ✅ | 10 RPM, 250K TPM, 1M TPD |
| **Cerebras** | Qwen 3 235B | 131K | text | ✅ | 30 RPM, 60K TPM, 1M TPD |
| **Groq** | QwQ 32B | 131K | text | ✅ | 30 RPM, 15K TPM, 500K TPD |
| **SambaNova** | DeepSeek R1 | 65K | text | ✅ | 10 RPM, 100K TPM, 1M TPD |
| **OpenRouter** | DeepSeek R1 (free) | 163K | text | ✅ | 20 RPM, 200K TPM, 1M TPD |
| **OpenCode Zen** | GPT OSS 120B | 128K | text | ✅ | 20 RPM, 100K TPM, 1M TPD |
| **NVIDIA NIM** | Llama 3.3 70B | 131K | text | ❌ | 20 RPM, 80K TPM, 1M TPD |
| **Cloudflare Workers AI** | Llama 3.3 70B | 131K | text | ❌ | 60 RPM, 100K TPM, 1M TPD; 80% safety cap by default |

## Management tool: `cheapskate`

| Action | What it does |
|---|---|
| `cheapskate action=status` | Show configured/available backend counts and the active backend. |
| `cheapskate action=list` | List all backends with model, configured/enabled/available state, limits, and cooldown. |
| `cheapskate action=usage` | Show current request/token counters per configured backend. |
| `cheapskate action=rotate` | Force rotation to the next available backend. |

## Automatic rotation

- Before each turn: picks the best available backend, preferring least-recently-used and then largest context.
- On 429/quota/rate-limit errors: rotates away from the failing backend and applies exponential cooldown.
- On context-limit errors: prefers an available backend with a larger context window.
- At 90% of RPM/TPM/TPD limits: marks the backend unavailable for rotation.
- Tracking resets: per-minute counters reset every 60 seconds; daily counters every 24 hours.

## Notes

- Free tiers change often; backend definitions should be audited periodically.
- The extension registers a virtual `cheapskate/auto` provider and rewrites requests to the active backend model internally.
- Non-secret settings use the direct backend add-on config API; API keys are stored in the Piclaw keychain.
