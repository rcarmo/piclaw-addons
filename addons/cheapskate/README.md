# Cheapskate

Free-tier provider auto-rotation for piclaw. Select `cheapskate/auto` as your model and requests are transparently routed to whichever free-tier backend is available, rotating on rate-limit errors.

## Install

Open **Settings → Add-Ons** and install **cheapskate** from the catalog.

## How it works

The addon registers a `cheapskate` provider with an `auto` model. When selected, it tries each enabled backend in order, skipping any that are rate-limited or have exhausted their free quota. If one backend fails, it rotates to the next.

Context-length errors also trigger rotation, so long conversations don't get stuck on a backend with a small context window.

## Backends

| Provider | Model | Context | Reasoning |
|---|---|---|---|
| Google Gemini | Gemini 2.5 Flash | 1M | ✅ |
| Cerebras | Qwen 3 235B | 131K | ✅ |
| Groq | QwQ 32B | 131K | ✅ |
| SambaNova | DeepSeek R1 | 65K | ✅ |
| OpenRouter | DeepSeek R1 (free) | 163K | ✅ |
| Cloudflare Workers AI | Llama 3.3 70B | 131K | ❌ |

Each backend requires its own API key set as an environment variable or keychain entry.

## Settings pane

Open **Settings → Cheapskate** to:

- Enable or disable individual backends
- Toggle safety caps on soft-cap providers (Cloudflare charges past the free tier)
- See which backends have valid API keys

## Configuration

Config is stored at `.pi/cheapskate.json` and auto-saved from the settings pane. Each backend can be individually enabled/disabled and soft-cap providers have a safety-cap toggle that prevents requests once the free allocation is exhausted.
