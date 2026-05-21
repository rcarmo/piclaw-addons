# @rcarmo/piclaw-addon-whatsapp

WhatsApp channel addon for PiClaw. Connects to WhatsApp Web via Baileys and routes messages through the agent.

## Configuration

| Env var | Description |
|---|---|
| `PICLAW_WHATSAPP_PHONE` | Phone number to connect (with country code) |
| `PICLAW_WHATSAPP_ENABLED` | Set to `1` to enable the channel |

## How it works

1. On `session_start`, lazy-loads the Baileys client and connects to WhatsApp Web
2. Registers a channel detector for WhatsApp JIDs (`@s.whatsapp.net`, `@g.us`) via `registerChannelDetector`
3. Inbound messages are posted to the agent via `__piclawRuntimeInterop.postMessage`
4. On `session_shutdown`, disconnects cleanly

## Files

- `index.ts` — Addon entry point: env gate, channel detector, lifecycle hooks
- `whatsapp.ts` — Baileys WhatsApp client (connection, messaging, presence)
- `whatsapp-presence.ts` — Typing indicator helpers
