---
name: remote-peer
description: Inspect and manage paired Piclaw instances through the remote_peer tool. The initial release exposes foundation status and identity; later versions add pairing and bang-address messaging.
distribution: public
---

# Remote Peer

Use the `remote_peer` tool to inspect the add-on.

```text
remote_peer({ action: "status" })
remote_peer({ action: "identity" })
```

The add-on owns a dedicated SQLite database and Ed25519 identity under Piclaw's scoped add-on data directory. It does not store peer or message ledgers in extension KV.

Pairing and `peer!target` messaging are introduced by later focused releases. Do not attempt to use the removed core `/pair`, `/ask`, or `/api/remote/*` surfaces.
