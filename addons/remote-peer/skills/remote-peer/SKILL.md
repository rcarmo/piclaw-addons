---
name: remote-peer
description: Inspect identity, request or approve signed pairing, ping peers, assign aliases, and revoke trust through the remote_peer tool.
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
remote_peer({ action: "revoke", peer: "peer-alias" })
```

Review the pending request's instance ID, fingerprint, display name, and callback URL before acceptance. Compare fingerprints out of band for sensitive peers. Never enable HTTP/private-network overrides without an explicit controlled-network reason.

The add-on owns a dedicated SQLite database and Ed25519 identity under Piclaw's scoped add-on data directory. It does not store peer or message ledgers in extension KV and never exposes the private key.

`peer!target` messaging is not available until the transport release. Do not use removed core `/pair`, `/ask`, or `/api/remote/*` surfaces.
