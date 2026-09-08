---
name: remote-peer
description: Manage Iroh client-ID pairing in Remote Peer Settings and use chat for trusted one-hop peer conversations.
distribution: public
---

# Iroh Remote Peer

Operators pair clients in Settings by pasting `PCL1-…` client IDs, comparing identity with the owner and explicitly approving requests. Internet address lookup is a separate opt-in for bare-ID dialing. Advanced endpoint tickets work without lookup. mDNS is off by default, settable in Settings, and never auto-pairs.

Agents use `chat({action:"directory"})` and only returned addresses/modes, such as `lab!inbox` and `lab!@research`. Send workspace `files` or `media_ids`; do not encode binary in message text. Use stable `idempotency_key` values for uncertain retries. Reply to supplied `peer!reply.…` addresses unchanged.

Operator `remote_peer` actions: `status`, `identity`, `ticket`, `pair`, `accept`, `deny`, `revoke`, `forget`, `alias`, `policy`, `advertise`, `unadvertise`, `ping`, `retry`, `work_send`, `work_review`. Pair uses `client_id` with optional `alias` and `ticket`. Acceptance/revocation/removal require full client-ID confirmation. Wider incoming permissions require `ALLOW REMOTE ACCESS`.

Pairing grants no direct remote tool execution. Work proposals and execute-labelled requests both require review and a locally supplied result.

This implementation uses only Iroh peer transport and fresh state. HTTP URLs, the old /pair command, old tool actions and old peer databases are unsupported. Do not migrate or delete legacy installed data. Do not enable networking, public lookup or mDNS without operator direction.
