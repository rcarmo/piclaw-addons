# Remote Peer — Iroh

Connect Piclaw instances by client ID using Iroh QUIC. All peer traffic uses Iroh, with direct connections and encrypted relay fallback. No public inbound HTTP endpoint is needed.

This is a clean break from Remote Peer 0.2: no old clients, HTTP peer routes, database migration or identity import. Existing installed files are left untouched. Both ends must install the new version and pair again.

## Pair in Settings

Settings uses the host's Classic/Visual controls with full-width fields, compact
section dividers and wrapped action rows. Long client IDs, peer names and delivery
errors stay inside the pane on narrow screens. Incoming and outgoing permissions
remain separate; these layout changes do not alter trust or transport behaviour.

The [operator guide](docs/operator-guide.md) provides the complete Settings walkthrough, including discovery, relay choices, permissions, rotation and recovery.

### Fresh setup

![Fresh Remote Peer Settings with client ID and discovery off](assets/settings-fresh.png)

The fresh pane exposes the stable `PCL1-…` client ID and pasted-ID pairing. Internet address lookup and mDNS are separate controls and both start off.

### Paired client

![Paired Remote Peer Settings with restricted permissions](assets/settings-paired.png)

New pairings start with inbox-only, queue-only access and files disabled. Broader incoming permissions require explicit confirmation.

1. Enable Remote Peer on both instances and set their names.
2. Copy the **Your client ID** value (`PCL1-…`).
3. For internet ID-only pairing, explicitly enable **Internet address lookup** on both instances. This publishes/resolves endpoint addresses through Iroh's n0 services; it does not enumerate or trust peers.
4. Paste the other client ID under **Add peer**, choose a local alias, and request pairing.
5. On the recipient, compare the client ID with its owner and explicitly accept. Initial permissions are inbox-only, queue mode, files off.

Address lookup and mDNS are separate controls. Both default off. Without internet lookup, exchange an endpoint ticket using the advanced field, or opt into nearby discovery. A bare public key contains no routable address.

## Optional mDNS

**Enable mDNS on this network** is off by default. Disabled means no multicast socket, advertisement, browser query or discovery timer. Enabling advertises minimal public ID/version hints and displays nearby, untrusted candidates. Selecting a candidate fills the pairing ID; it never grants trust.

An optional IPv4 interface restricts advertisements. mDNS typically stays on one multicast segment; VLANs, VPNs, containers and access points may block it. Manual ticket pairing still works. The implementation uses `bonjour-service@1.4.4` on Bun's `node:dgram` compatibility; no system Bonjour/Avahi service is required.

## Chat and permissions

Agents use the normal `chat` tool:

```text
chat({ action: "directory" })
chat({ target_address: "lab!inbox", content: "Please review this", mode: "queue", idempotency_key: "review-1" })
```

Advertise a local agent and explicitly grant it before using `lab!@research`. Reply to supplied opaque `lab!reply.…` addresses without decoding them. Queue/auto/steer and file permissions remain receiver-controlled. Broader permissions require `ALLOW REMOTE ACCESS` confirmation.

Files are sent as raw bytes inside bounded Iroh frames: four files maximum, 16 MiB each, 32 MiB total. SHA-256 is checked at both ends. Outbound payloads are stored until acknowledged; retries reuse message IDs and return a stored receipt without duplicating normal completed delivery.

If the receiver crashes between calling Piclaw delivery and recording the receipt, its record remains `delivering`. Retries report an unknown outcome rather than risking duplicate tool-triggering messages. Inspect that record before taking further action; exactly-once delivery across that crash boundary is not claimed.

Work requests remain operator-mediated. Neither a pairing nor an `execute` request grants tool execution. Reviewed results may be returned from Settings or the management tool.

### Per-peer permission editor

Each paired peer shows two separate directions:

- **Incoming — what this peer may send to this instance:** saved local scope,
  delivery modes, named agents and file permission. Select **Edit incoming
  permissions** to change a draft, then **Apply** to save. **Revert** reloads the
  currently displayed saved policy; **Cancel** discards the draft and closes the
  editor. Neither writes permissions. File-only edits preserve other fields,
  including selected aliases that are no longer advertised.
- **Outgoing — what this instance may send to this peer:** a read-only remote
  advertisement. **Refresh remote permissions** fetches it explicitly over the
  authenticated peer connection. Opening Settings does not fetch remote rosters.
  Not-fetched, last-fetched, stale and unavailable states are labelled. These are
  snapshots; actual sends recheck the peer's advertised permissions.

Broader incoming policies still require typing `ALLOW REMOTE ACCESS`. Apply is
disabled while saving, with no delivery modes selected, or when polling detects
that the saved policy changed during editing. Success appears only after a
separate dashboard read verifies the saved policy. Failures retain the draft and
show an error. A failed readback can follow a successful write; Revert or retry
to reconcile rather than assuming the write failed.

Apply includes the original saved policy and pairing epoch. The backend compares
them and writes under one SQLite transaction; a concurrent restriction or
re-pairing rejects the stale draft without changing permissions. Readback also
checks that pairing epoch. The optional `expected_policy`/`expected_epoch` fields
are supported by the management API; older explicit operator policy calls remain
compatible, while Settings always supplies both.

Sending files **to** a peer requires that peer to allow incoming files from this
instance. Enabling incoming files locally affects the opposite direction. The
sender must refresh its directory after the receiver applies changes. The four
file / 16 MiB each / 32 MiB total limits are enforced protocol bounds, not editable
permissions. Revocation/removal and their confirmations stay separate.

All text, select and multiline fields use the host's shared same-skin Settings
controls, associated labels and bounded widths. Classic retains its existing
field shape; Visual uses its own shape. A scoped fallback keeps older supported
hosts readable. Native checkbox/radio controls are not stretched or restyled as
text fields.

## Storage and dependencies

Fresh state lives under `<addon-data>/iroh-v1/`: `secret-key.bin` (32 bytes, mode 0600), `peers.db` and SQLite WAL files. The Iroh Ed25519 public key is the client identity, displayed with a checksum for copying. The secret is never returned by Settings or tools. Old `state.db` and `identity.json` are not read or changed.

Pinned dependencies: `@number0/iroh@1.1.0` (prebuilt N-API) and `bonjour-service@1.4.4`. No local Rust/native compiler is required. The published Iroh entrypoint layout is handled by loading its explicit root `index.js`. Unsupported native targets receive an error rather than a source-build attempt. Target runtime: Bun 1.4.1 and Piclaw 3.0.1 or newer with add-on lifecycle API v1 (core PRs #1285 and #1288).

Custom relays require HTTPS URLs. Authentication is an optional keychain entry name, never a secret pasted into configuration. Do not enable public address lookup if private address publication is unacceptable. Iroh relay networking may itself use HTTP/WebSocket internally; the removed HTTP transport is Remote Peer's application transport.

## Management API

`remote_peer` actions: `status`, `identity`, `ticket`, `pair`, `accept`, `deny`, `revoke`, `forget`, `alias`, `policy`, `remote_permissions`, `advertise`, `unadvertise`, `ping`, `retry`, `work_send`, `work_review`.

Settings uses `/agent/addons/api/remote-peer/config` and `/dashboard`. The old `/pair` command and HTTP pairing protocol are removed. Removing a revoked record requires full-ID confirmation and only permits a new explicit pairing attempt.

`POST /agent/addons/api/remote-peer/dashboard` with
`{"action":"remote_permissions","peer":"<id-or-alias>"}` returns a validated
remote roster in `result`. It never writes local policy and fails if the peer is
revoked, replaced or disabled while the request is in flight.

## Documentation

- [Operator guide](docs/operator-guide.md) — installation requirements, Settings, pairing, discovery, relays, policies, recovery and identity rotation
- [Protocol](docs/protocol.md) — framing, signatures, operations and pairing semantics
- [Security boundaries](docs/security.md) — trust, limits, secrets and crash behavior
- [Troubleshooting](docs/troubleshooting.md) — common connection and pairing failures
- [Mediated work](docs/mediated-work.md) — reviewed proposal/result flow
- [Implementation evidence](docs/e2e-matrix.md) — local, hosted, mDNS and forced-relay validation

## Validation status

See [test evidence](docs/e2e-matrix.md). Local Bun 1.4.1 tests cover real loopback QUIC pairing/messages/files/replies, persistence, permission gates, frame/signature rejection and discovery lifecycle. A same-host n0 probe passed bare-client-ID pairing with mDNS off. Smith and VM 900 passed real two-device multicast discovery, explicit approval and one message over a direct Iroh path. Separate Docker networks with peer-address UDP rejected passed one message over the selected EU n0 relay. These owned fixtures were removed after verification.
