# Iroh peer protocol 1

ALPN: `piclaw-remote-peer/iroh/1`. This protocol is incompatible with the removed HTTP protocol.

Each connection handles one bidirectional request/response stream. A four-byte big-endian header length precedes a JSON header (maximum 192 KiB), then up to 32 MiB of raw binary. The receiver rejects unauthorized binary bodies before allocation. Reads/writes use 64 KiB chunks. Inbound concurrency is capped at 16; outbound requests/dials at eight; requests time out after 30 seconds.

The signed header contains `v,id,op,from,to,time,nonce,size,hash,body,signature`. Identity is the Iroh endpoint public key. The receiver compares it to the authenticated QUIC peer, verifies destination, version, timestamp (90 seconds), body size/SHA-256 and Ed25519 signature, then rejects repeated nonces. Replies echo the request ID and are signed by the expected endpoint.

Operations: `pair`, `confirm`, `ping`, `roster`, `message`, `revoke`, `work`, `work-result`, `reply`. Only pairing operations accept unpaired clients, and cannot contain binary data. Other operations require a paired ID and matching random authorization epoch. Revocation changes the epoch and rejects later operations.

The initiating operator supplies the expected client ID. A signed pair request includes a one-hour request ID/epoch and an endpoint ticket matching the actual QUIC peer. The recipient must confirm the full client ID locally before sending confirmation. Repeated matching requests are idempotent. Concurrent reverse requests are rejected for operator resolution. A revoked ID remains blocked until explicitly removed.

## Session roster and local management

Session addresses use `peer!@agent/session`. Signed rosters contain `sessions` entries with `agent`, `session_alias`, `target_kind: "session"`, `modes` and `status` (`ready`, `stale` or `unreachable`). Chat JIDs and incarnations stay local. The roster exposes only sessions with explicit grants and non-empty effective modes. `all-advertised` applies to agents and does not grant sessions.

Receiver session advertisements bind `(agent, session_alias)` to `(local_agent, chat_jid, incarnation)` with an opaque, durable `revision`. Every advertisement or re-advertisement gets a new revision, even for the same target and modes. Admission checks the grant's revision, mode and exact lifetime. Idle sessions are valid. Stale incarnations reject delivery; missing host APIs produce unavailable/unreachable state without an unbound fallback.

The authenticated local Settings API uses `POST /agent/addons/api/remote-peer/dashboard`:

- `{"action":"session_targets"}` returns `result: [{chatJid, agentName, incarnation, active}]`. Request-scoped local context is required.
- `session_advertise` takes `agent`, `session_alias`, `chat_jid`, `incarnation` and `modes`.
- `session_unadvertise` takes `agent` and `session_alias`, removes the advertisement and its grants.
- `policy` accepts `sessions: [{agent, session_alias, revision, modes}]` alongside scope, peer modes, agents and files. Copy `revision` from the selected local advertisement; it is not the session incarnation. Settings sends these grants in `expected_policy` and verifies them on readback. Explicit grants with missing or mismatched revisions are rejected under the policy write transaction, even when saved policy and pairing epoch are unchanged. Any non-empty session grant list requires `ALLOW REMOTE ACCESS`. Calls omitting `sessions` preserve existing grants, but do not upgrade legacy grants lacking revisions into effective access.

Dashboard `advertised_sessions` rows contain `agent`, `session_alias`, `local_agent`, `chat_jid`, `incarnation`, `revision`, JSON-encoded `modes` and `status`. `remote_permissions.result.sessions` contains the validated remote session roster, not local revision authority. Every re-advertisement clears previous grants; hiding also removes them. Persisted legacy advertisements receive revisions without upgrading legacy grants. Roster and receive checks reject grants whose revision does not match.

Address records are routing hints, not authority. Manual tickets and mDNS candidates must agree with the expected key. Public Iroh lookup is a separately enabled setting used for bare-ID internet dialing. mDNS defaults off and never auto-pairs.
