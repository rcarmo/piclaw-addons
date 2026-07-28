# Remote Peer

`@rcarmo/piclaw-addon-remote-peer` owns cross-instance Piclaw identity, state, pairing and messaging. The foundation release creates a fresh Ed25519 identity and dedicated SQLite database. Pairing and bang-address messaging are added in subsequent focused releases.

## Requirements

- Piclaw `>=2.12.0`
- Messaging runtime API v1
- External routes API v1

The add-on does not import Piclaw runtime internals.

## Storage

The add-on uses Piclaw's scoped data directory:

```text
<PICLAW_DATA>/addons/remote-peer/
├── identity.json
├── state.db
├── state.db-wal
├── state.db-shm
└── backups/
```

`identity.json` is written with mode `0600` where supported. `state.db` uses WAL, foreign keys, secure delete, a five-second busy timeout, integrity checks and explicit checksummed migrations.

Peer, message, proposal, receipt and audit ledgers are relational tables in `state.db`. They are not stored in extension KV and are not added to Piclaw's `messages.db`.

Normal add-on uninstall preserves the scoped data directory. Destructive identity/database reset will be an explicit confirmed Settings action in a later release.

## Foundation tool

```text
remote_peer({ action: "status" })
remote_peer({ action: "identity" })
```

Only public identity metadata is returned. The private key is never returned through tools or the Settings API.

## Settings

The initial Settings pane exposes:

- enabled state;
- instance display name;
- external URL;
- explicit HTTP/private-network development overrides;
- public fingerprint and schema version.

Runtime changes require a Piclaw restart.

## Current scope

This foundation release does not register transport endpoints or the bang-address chat transport. Those arrive after signed pairing and peer-management work is complete.
