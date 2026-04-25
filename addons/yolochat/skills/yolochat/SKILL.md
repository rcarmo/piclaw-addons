# YoloChat Skill

Use the `yolochat-send.ts` script to send messages to other Pi instances over HTTP.

## Address format

```
<chat_jid>@<hostname>:<port>
```

Examples:
- `web:default@192.168.1.50:3000`
- `web:lab@pi.local:3000`

## Envelope format

Messages use a UUCP/SMTP-like text envelope:

```
From: web:default@10.0.0.5:3000
To: web:default@10.0.0.10:3000

Hello from my instance!
```

The envelope is posted as the `content` field of a standard piclaw agent message POST.

## Sending a message

Pipe the message body into the script via stdin:

```bash
echo "Hello!" | bun /path/to/yolochat/scripts/yolochat-send.ts web:default@192.168.1.50:3000
```

Multiline messages:

```bash
cat <<'EOF' | bun /path/to/yolochat/scripts/yolochat-send.ts web:default@192.168.1.50:3000
First line
Second line
Third line
EOF
```

## Receiving messages

Incoming yolochat messages arrive as normal user messages in the target chat timeline. They contain the envelope headers (`From:` / `To:`) followed by the message body.

Parse the `From:` header to know who sent it and to reply back.

## Replying

Extract the `From:` address from the received envelope and use it as the target for your reply:

```bash
echo "Got your message, thanks!" | bun /path/to/yolochat/scripts/yolochat-send.ts web:default@10.0.0.5:3000
```

## Constraints

- No authentication or encryption — same-network only
- Messages are fire-and-forget; delivery is best-effort
- The remote instance must be reachable over HTTP on the specified port
- This is NOT a replacement for `/pair` — zero security guarantees
