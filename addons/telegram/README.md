# Telegram integration

Telegram is an **optional secondary channel** for mobile-first chat access.
The web UI remains the primary interface.

Requires Piclaw `>=2.0.0`.

## Enable

Open **Settings → Telegram**, save the BotFather token, enable the channel, then reload Piclaw. The token is stored in the Piclaw keychain as `telegram/bot-token`; non-secret settings use the direct add-on config API and extension KV.

Environment overrides are also supported:

```bash
PICLAW_TELEGRAM_ENABLED=1
TELEGRAM_BOT_TOKEN=123456789:your_botfather_token
```

`PICLAW_TELEGRAM_BOT_TOKEN` and legacy KV-stored tokens remain readable for backward compatibility, but new secrets are written only to the keychain.

If disabled (or missing a token), the add-on remains inactive and Piclaw continues normally.

## Chat IDs and topics

Piclaw stores Telegram chats as `chat_jid` values like:

- `telegram:123456789` (DM)
- `telegram:-1001234567890` (group/supergroup)
- `telegram:-1001234567890:topic:42` (forum topic)

## Notes

- Telegram uses long polling by default.
- Telegram sends assistant messages unchanged; unlike WhatsApp, it does not prepend the assistant name.
- Telegram formatting guidance is applied in channel-specific prompt hints.
- This channel is opt-in and lazy-loaded, so default web-first setups pay no Telegram startup cost.

## Disable

Disable the channel in **Settings → Telegram**, then reload Piclaw. Unsetting `PICLAW_TELEGRAM_ENABLED` disables environment-based enablement but does not override an enabled value saved through Settings.
