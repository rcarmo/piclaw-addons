# Telegram integration

Telegram is an **optional secondary channel** for mobile-first chat access.
The web UI remains the primary interface.

## Enable

Open **Settings → Telegram**, save the BotFather token, and enable the channel. The token is stored in the Piclaw keychain as `telegram/bot-token`; non-secret settings use the direct add-on config API and extension KV.

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
- Messages are prefixed with assistant name, same as WhatsApp behavior.
- Telegram formatting guidance is applied in channel-specific prompt hints.
- This channel is opt-in and lazy-loaded, so default web-first setups pay no Telegram startup cost.

## Disable

Unset `PICLAW_TELEGRAM_ENABLED` (or set to `0` / `false`).
