# Remote Peer security model

## Trust boundary

Pairing grants a remote Piclaw instance a durable cryptographic identity. It does not grant shell access, tool execution, arbitrary agent routing, or mediated work. Those capabilities remain unavailable until later protocol stages add explicit local policy.

An operator must review and accept every inbound pairing request. Display names and callback URLs are untrusted labels; compare fingerprints out of band when identity assurance matters.

## Controls

- Fresh per-installation Ed25519 identity; no legacy state migration.
- Private key kept outside SQLite and excluded from every public response.
- Dedicated scoped SQLite store with WAL, foreign keys, checksummed migrations, backups, and integrity checks.
- Public-key validation and deterministic instance IDs.
- URL ownership proof before trust is activated.
- HTTPS/public-network policy by default, with explicit development overrides.
- Exact-body request signatures, signed delivery receipts, timestamp skew checks, bounded nonce replay protection, trust epochs, and endpoint rate limits.
- Pairing disabled globally when the add-on is disabled.
- Local aliases are unique and operator-controlled.
- The message source peer is derived from signature authentication; spoofable body labels cannot replace it.
- Inbox delivery is queue-only by default, and duplicate IDs/idempotency keys return one stored receipt and one timeline delivery.
- File transfer is disabled per peer by default. Enabled transfers use bounded raw binary requests, signed SHA-256 verification, receiver-owned size limits, mode-0600 temporary files, durable retry data and normal Piclaw media storage.
- Signed rosters expose only operator-selected aliases, never local chat JIDs or the complete local agent list.
- Agent access requires receiver-owned peer scope plus alias permission; delivery modes must pass both peer and alias ceilings.
- Reply capabilities are signed, random, expiring, peer-bound, and stored hashed; their private mapping never crosses the instance boundary.
- Revocation is fail-closed locally even if remote notification fails.
- Security-relevant transitions are recorded in `transport_audit` without private key material.

## Operator guidance

- Keep `allowHttp` and `allowPrivateNetwork` off in production.
- Publish only the `/api/addons/remote-peer/v1/*` route through a TLS reverse proxy.
- Restrict outbound network access if DNS rebinding or internal-network reachability is a concern.
- Compare fingerprints over an independent channel before accepting sensitive peers.
- Revoke and re-pair after suspected key compromise. There is no compatibility fallback or identity import.
- Back up the scoped add-on data directory as one unit. Restoring only `state.db` or only `identity.json` can invalidate trust relationships.

## Mediated work boundary

Remote work is authorization by local human review, not by pairing alone. Inbound proposal and execute shapes both remain pending until an operator supplies the reviewed result or rejection. Capability profiles are declarative allowlists used to constrain review; they cannot invoke Piclaw tools. Approval can only reduce the requested capability set. Chain hop and live-chain checks prevent recursive loops, and signed callbacks complete an outbound request only once.

## Current non-goals

The protocol does not provide message confidentiality, forward secrecy, certificate pinning, distributed revocation, multi-hop work execution, or direct remote tool access. HTTPS protects transport confidentiality; Ed25519 signatures authenticate requests and detect mutation.
