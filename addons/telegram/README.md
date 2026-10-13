# Telegram integration

Telegram is an **optional secondary channel**. The web UI remains the primary interface.
Requires Piclaw `>=3.3.2` in single-user mode.

## Inbound agent access is currently disabled

Version 0.3.1 is fail-closed: the current Piclaw runtime has no supported unattended
capability combining exact target-lifetime admission, cancellation and host-bound
message references. Allowlisted plain text gets:

> Agent access via Telegram is not available yet on this Piclaw version.

Nothing is enqueued to the agent. See the PR discussion about the pending host
capability. There is no fallback to raw enqueue, prompt-text matching, source
strings or session IDs. The browser-only `localContext.enqueue` cannot be retained
by the background poller. The injected ingress interface is exercised by tests;
the startup runtime supplies `ingress: null`.

Polling starts independently of agent sessions and can answer local notices.
`/start` also reports that agent access is unavailable when there is no supported
ingress; with a supported ingress it keeps the normal connected greeting.
If a future supported ingress is integrated, only a matching host-provided
`{addonId, intentId}`, chat JID and incarnation can claim a reply. Other web,
side-session or scheduled activity is never mirrored. One reply obligation is
open at a time, including while sending a multipart or retrying reply.

Recovery also requires the same host reference and lifetime. Host references
belong only to the admitted prompt, so ordinary recovery prompts usually lack
one; they cannot inherit ownership by matching a neutral prompt string. A failed
claimed attempt without provenanced recovery gets a failure notice after ten
minutes. Ingress admission with an uncertain result is never automatically retried;
the sender gets an uncertainty notice pointing to the web chat, unless stop/disable
owns the terminal notice. An interrupted admission without a verified receipt
gets a failure or uncertainty notice and releases the obligation.

## Access control

Only new plain text `message` updates from an allowlisted non-bot user in that
user's own private chat are accepted. Edits, channel posts, groups, anonymous
senders and forwarded messages are ignored. Messages sent before polling
activation are ignored, including messages sent while Piclaw was down.

Strangers receive no reply. Allowlisted users get local notices for unsupported
messages or commands. Slash commands, the `!` shell alias and `@mentions` are
refused. No allowlist or no dedicated target lifetime means no polling.

Update IDs must be safe nonnegative integers with a safe successor. Duplicates
and IDs below the high-water offset are dropped before authorization or notices;
valid ignored updates also advance the offset. The offset is retained in memory
across reloads and token rotation for the same bot ID returned by `getMe`; a bot
change resets it. A process restart loses the offset; the activation-time filter
still prevents replay of older messages. This is not durable exactly-once delivery.

## Configure

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. Create a dedicated web chat (not `web:default`).
3. Open **Settings → Telegram**, enter the token and allowed numeric user IDs,
   select the target branch, enable polling and save.

The picker lists sibling branches separately, with their incarnation and JID.
Settings persist both `targetChatJid` and `targetIncarnation`. Material saves
require verified local request context; enabling also requires exact target
resolution. A deleted/recreated chat rejects an enabled save, but never blocks
disabling. Rejected saves leave the running poller untouched. Older settings
without an incarnation must be reselected in Settings before polling can start.

The token is stored in keychain entry `telegram/bot-token`. Non-secret settings
are stored in global extension KV. Token lookup order is `TELEGRAM_BOT_TOKEN`,
`PICLAW_TELEGRAM_BOT_TOKEN`, keychain, then legacy KV. New tokens are written only
to the keychain. Environment overrides are supported:

```bash
PICLAW_TELEGRAM_ENABLED=1
TELEGRAM_BOT_TOKEN=123456789:your_botfather_token
PICLAW_TELEGRAM_ALLOWED_USER_IDS=123456789
PICLAW_TELEGRAM_TARGET_CHAT_JID=web:telegram
PICLAW_TELEGRAM_TARGET_INCARNATION=existing-branch-id
PICLAW_TELEGRAM_POLLING_TIMEOUT=30
```

Allowed users would have the same agent/tool rights as the selected web chat
once host ingress is supported. Only allowlist accounts you control.

## Saving, stopping and disabling

A no-op settings save with the same active token does not restart polling or
interrupt a reply. Keychain token changes take effect on save. Any material change
or reload with an open reply obligation is rejected visibly without fencing
ingress. Wait for delivery, or explicitly disable first. An enabled-to-disabled
save is the exception: it is an explicit stop.

Stop/disable fences admission and polling synchronously. Telegram delivery has a
separate lifetime: an already-started send or retry wait drains before the old
transport closes. Remaining reply chunks/retries are not forwarded. Every open
obligation receives the terminal notice (subject to Telegram transport failure):

> Telegram forwarding stopped. The reply to your message will not be forwarded;
> agent work may still continue in the web chat.

A reply send failure instead gets a single delivery-failure notice, without
retrying that notice. The terminal notice is reserved for stop/disable.

This does **not** claim that agent work was aborted. `PICLAW_TELEGRAM_ENABLED=1`
forces effective enablement, even when stored `enabled` is false. Settings disable
is rejected with an explicit environment-enablement error while that override is
set; unset it before disabling. Rejection leaves polling and status unchanged.
A save that results in effective-disabled settings fences polling immediately.
No-op detection uses effective settings and the active token, so environment-only
enablement does not hide a token change.

Text-like settings controls use the host's shared `settings-addon-*` styling,
with a package-local fallback for older hosts. Tokens remain keychain-only.
