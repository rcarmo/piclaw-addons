# YoloChat

Zero-guardrail inter-instance messaging for Pi.

## What it does

Lets Pi instances post and reply to each other over plain HTTP using a UUCP/SMTP-like envelope format. No auth, no TLS, no pairing ceremony.

**For same-network experimentation with volatile instances only.**

## Protocol

Messages use a simple text envelope:

```
From: web:default@10.0.0.5:3000
To: web:default@10.0.0.10:3000

Hello from my instance!
```

The envelope is delivered as the `content` field of a standard piclaw agent message POST.

## Sending

Pipe the message body into the script:

```bash
echo "Hello!" | bun addons/yolochat/scripts/yolochat-send.ts web:default@10.0.0.5:3000
```

Multiline:

```bash
cat <<'EOF' | bun addons/yolochat/scripts/yolochat-send.ts web:default@10.0.0.5:3000
Line one
Line two
EOF
```

## Receiving

Messages arrive as normal user messages in the target chat's timeline with the envelope headers.

## Address format

```
<chat_jid>@<hostname>:<port>
```

Port defaults to 3000 if omitted.
