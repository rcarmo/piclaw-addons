# piclaw-addon-imap

IMAP email management addon for piclaw.

Includes a web settings pane for managing accounts.

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

The settings pane stores:

- non-secret account settings in the extension SQLite KV store
- passwords in keychain at `imap/<name>/password`

Legacy single-secret entries like `imap/personal` are still read as a fallback.

Then use `account: "personal"` in tool calls, or set:

```bash
export IMAP_DEFAULT_ACCOUNT=personal
```

## Notes

- No SMTP support.
- This addon cannot send mail; it only manipulates mailboxes over IMAP.
- `allowInsecureTls=true` is only for broken/self-signed/private/expired-cert servers.
- Account management is available both through the settings pane and through `imap` tool actions like `list_accounts`, `save_account`, and `delete_account`.
