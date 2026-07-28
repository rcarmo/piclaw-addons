# Remote Peer

`@rcarmo/piclaw-addon-remote-peer` owns cross-instance Piclaw identity, state, pairing and messaging. It creates a fresh Ed25519 identity and dedicated SQLite database, then establishes operator-approved peer trust through signed pairing. Bang-address messaging is added in a subsequent focused release.

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

## Pairing and management

```text
remote_peer({ action: "status" })
remote_peer({ action: "identity" })
remote_peer({ action: "list_peers" })
remote_peer({ action: "pending" })
remote_peer({ action: "pair_request", url: "https://peer.example" })
remote_peer({ action: "accept_pair", request_id: "pair_..." })
remote_peer({ action: "deny_pair", request_id: "pair_..." })
remote_peer({ action: "ping", peer: "peer-alias" })
remote_peer({ action: "set_alias", peer: "peer-alias", alias: "new-alias" })
remote_peer({ action: "revoke", peer: "peer-alias" })
```

The `/pair` command provides equivalent operator actions. Only public identity metadata is returned. The private key is never returned through tools, commands, external routes, or the Settings API.

See [PROTOCOL.md](PROTOCOL.md) for the signed protocol and [SECURITY.md](SECURITY.md) for trust boundaries and deployment guidance.

## Settings

The initial Settings pane exposes:

- enabled state;
- instance display name;
- external URL;
- explicit HTTP/private-network development overrides;
- public fingerprint and schema version.

Runtime changes require a Piclaw restart.

## Current scope

This release registers only pairing, signed ping, and revoke endpoints. It does not yet register the bang-address chat transport, advertised-agent routing, or mediated remote work.
