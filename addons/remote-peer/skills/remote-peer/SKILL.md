---
name: remote-peer
description: Manage Iroh client-ID pairing in Remote Peer Settings and use chat for trusted one-hop peer conversations.
distribution: public
---

# Iroh Remote Peer

Operators pair clients in Settings by pasting `PCL1-…` client IDs, comparing identity with the owner and explicitly approving requests. Internet address lookup is a separate opt-in for bare-ID dialing. Advanced endpoint tickets work without lookup. mDNS is off by default, settable in Settings, and never auto-pairs.

Agents use `chat({action:"directory"})` and only returned addresses/modes, such as `lab!inbox` and `lab!@research`. Send workspace `files` or `media_ids`; do not encode binary in message text. Use stable `idempotency_key` values for uncertain retries. Reply to supplied `peer!reply.…` addresses unchanged.

Operator `remote_peer` actions: `status`, `identity`, `ticket`, `pair`, `accept`, `deny`, `revoke`, `forget`, `alias`, `policy`, `remote_permissions`, `advertise`, `unadvertise`, `session_targets`, `session_advertise`, `session_unadvertise`, `ping`, `retry`, `work_send`, `work_review`. Pair uses `client_id` with optional `alias` and `ticket`. Acceptance/revocation/removal require full client-ID confirmation. Wider incoming permissions require `ALLOW REMOTE ACCESS`.

Settings exposes per-peer incoming drafts with Apply/Cancel/Revert and a separate read-only outgoing advertisement. `remote_permissions` explicitly refreshes one paired peer's remote roster; it does not grant permissions. To send files to a peer, the receiver must enable incoming files for this instance, then the sender refreshes its directory. File-only edits preserve scope, named agents and modes. No networking is enabled automatically.

Session targets are operator opt-in. Advertise the local agent first, then use **Advertised sessions** to choose an exact local target, advertised agent alias, public session alias and modes. Idle sessions are valid. Each peer needs an explicit session grant in the existing incoming draft and typed `ALLOW REMOTE ACCESS` consent. Neither named-agent selection nor `all-advertised` grants sessions implicitly. File-only edits preserve session grants.

Use `peer!@agent/session` only when returned by the directory, with its returned modes and status. Outgoing Settings displays read-only session grants. Stale incarnations reject delivery without named-agent fallback; older hosts without incarnation-bound APIs report unavailable/unreachable targets. Hiding an advertisement clears its grants. Every advertisement/re-advertisement creates a fresh revision and requires fresh grants, even for the same lifetime. Explicit `policy.sessions` grants must include the selected advertisement's `revision` alongside `agent`, `session_alias` and `modes`; never invent or reuse a stale revision. Advertisement changes invalidate typed consent even with no saved grants: use Revert, reselect the current session and confirm afresh. Retyping or toggling a stale draft cannot unblock Apply. Session management requires request-scoped local authority; never invent a chat JID or incarnation.

Pairing grants no direct remote tool execution. Work proposals and execute-labelled requests both require review and a locally supplied result.

This implementation uses only Iroh peer transport and fresh state. HTTP URLs, the old /pair command, old tool actions and old peer databases are unsupported. Do not migrate or delete legacy installed data. Do not enable networking, public lookup or mDNS without operator direction.
