# piclaw-addon-imap

IMAP email management addon for piclaw.

## Features

- list folders
- search messages
- fetch envelopes or full message source
- move/copy messages
- add/remove IMAP flags
- create drafts via IMAP `APPEND`
- file composed messages into arbitrary folders
- create/delete folders
- implicit TLS (`993`) or STARTTLS (`143`)

## Account config

Store one JSON keychain entry per account:

```bash
keychain set imap/personal '{
  "host": "imap.example.com",
  "port": 143,
  "user": "user@example.com",
  "pass": "app-password",
  "tls": false,
  "starttls": true,
  "from": "Your Name <user@example.com>",
  "allowInsecureTls": false
}'
```

Then use `account: "personal"` in tool calls, or set:

```bash
export IMAP_DEFAULT_ACCOUNT=personal
```

## Notes

- No SMTP support.
- This addon cannot send mail; it only manipulates mailboxes over IMAP.
- `allowInsecureTls=true` is only for broken/self-signed/expired-cert servers.
