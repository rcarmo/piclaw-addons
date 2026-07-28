---
name: remote-peer
description: Pair and manage Piclaw peers, inspect message delivery, and send durable signed peer!inbox messages through the chat tool.
distribution: public
---

# Remote Peer

Use `remote_peer` for pairing and trust management.

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
remote_peer({ action: "message_status", message_id: "rmsg_..." })
remote_peer({ action: "message_failures" })
remote_peer({ action: "revoke", peer: "peer-alias" })
```

Review the pending request's instance ID, fingerprint, display name, and callback URL before acceptance. Compare fingerprints out of band for sensitive peers. Never enable HTTP/private-network overrides without an explicit controlled-network reason.

The add-on owns a dedicated SQLite database and Ed25519 identity under Piclaw's scoped add-on data directory. It does not store peer or message ledgers in extension KV and never exposes the private key.

Send a durable inbox message with Piclaw's existing chat tool:

```text
chat({ target_address: "lab!inbox", content: "Please review this finding.", mode: "queue", idempotency_key: "stable-key" })
```

Use `@alias` for local agents and `peer!inbox` for a paired remote instance. Bang addresses are one hop only. This release permits only the remote inbox and `queue`; advertised `peer!@alias` targets, replies, `auto`, and `steer` arrive later. Prefer a stable idempotency key when retrying uncertain deliveries.

Do not use removed core `/pair`, `/ask`, or `/api/remote/*` surfaces.
