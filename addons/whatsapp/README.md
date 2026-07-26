# @rcarmo/piclaw-addon-whatsapp

WhatsApp channel add-on for Piclaw. The current package is not self-contained for standalone catalog use: its runtime imports Baileys, `qrcode-terminal`, and shared Piclaw channel modules that its manifest does not supply.

Requires Piclaw `>=2.0.0`.

## Configuration

Use **Settings → WhatsApp** to store the phone number and enable the channel through the direct add-on config API, then reload Piclaw. Environment overrides are also supported:

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
