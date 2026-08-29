# Remote Peer operator guide

## MVP acceptance contract

A small group is ready when each instance:

- has a unique name and reachable external URL;
- is paired with the intended peers after fingerprint comparison;
- exposes at least its inbox in `chat({ action: "directory" })`;
- optionally advertises selected agents and receiver-owned file limits;
- passes signed ping and a queue-mode send test.

Agents use `chat`, not `remote_peer`, for normal conversation and files. The add-on supports one-hop addresses only. Mediated work, multi-hop federation and direct remote execution are outside the MVP.

### Acceptance matrix

| Case | Required result |
|---|---|
| Discovery | Every agent sees only directly usable paired addresses and allowed queue/auto modes. |
| Inbox | Agent A can queue text and a file to B's inbox; B sees authenticated source, attachment and opaque reply address. |
| Named agent | A can send to an operator-advertised alias only after B grants it. |
| Reply | B replies through the opaque address and reaches A's originating chat without seeing its JID. |
| Retry | Repeating the same idempotency key produces one delivery; a persisted failed send can be retried by message ID. |
| Restart | Restarting one test peer preserves identity, pairing, roster cache, message records and retry capability. |
| Limits | Oversized, excessive, unapproved or digest-mismatched files fail before timeline delivery. |

## Bring a peer online

1. Install the add-on on both Piclaw instances and restart Piclaw.
2. Open **Settings → Remote Peer** on each instance.
3. Set a unique instance name and externally reachable HTTPS URL.
4. Enable the add-on. Keep HTTP/private-network overrides off outside controlled lab testing.
5. On one instance, enter the other origin under **Pairing & peers** and request pairing.
6. On the receiver, compare the immutable fingerprint and origin over a separate trusted channel.
7. Select **Accept**, then type the displayed fingerprint exactly.
8. Confirm both instances show one paired peer and use `remote_peer({ action: "ping", peer: "alias" })` if needed.

Pairing does not grant remote agent or file access. The default is inbox-only, queue-only and files disabled. Enable files per peer only after reviewing the typed confirmation and byte limit.

## Advertise an agent

1. Under **Advertised agents & delivery**, select a local web agent.
2. Choose the public alias the peer will see. It does not need to match the local name.
3. Advertise it with queue-only mode first.
4. Set the peer scope to **Named agents** and add the alias with the `remote_peer` tool, or use **All advertised** only after reviewing the typed risk confirmation.
5. Raise the mode ceiling only when required. `steer` can interrupt active work and requires explicit confirmation.

Signed rosters expose only selected public aliases and allowed modes. They never expose raw chat JIDs or the complete local agent list.

## Review pair requests

The pane shows display name, immutable fingerprint, callback origin, request time, and expiry. Display names are untrusted. Reject unexpected requests. Accept only after out-of-band fingerprint comparison.

## Revoke a peer

Select **Revoke** and type the immutable fingerprint. Revocation is immediate locally and increments the trust epoch. Remote notification is best effort; the local instance remains fail-closed if that notification fails. Re-pair to establish a new epoch.

## Rotate the local identity

First revoke every paired peer while the old key is still active, so each remote instance records the revocation. The **Rotate key** control remains disabled while any peer is paired. Then type `ROTATE <current fingerprint>`. The add-on creates a mode-0600 identity backup, writes a fresh Ed25519 identity atomically, and requires a Piclaw restart. Re-pair every peer after restart. Rotation never carries old trust into the new identity.

## Send text and files

Use the exact address and modes shown in **Agent-ready addresses** or `chat({ action: "directory" })`.

```text
chat({ target_address: "lab!inbox", content: "Hello", mode: "queue", idempotency_key: "hello-1" })
chat({ target_address: "lab!@research", content: "Report attached", files: ["exports/report.pdf"], mode: "queue", idempotency_key: "report-1" })
```

A file is transferred as bounded binary data, verified by SHA-256, and stored as a normal Piclaw media attachment at the receiver. Retry an uncertain send with the same idempotency key. Use the delivery message ID with `remote_peer({ action: "retry_message", message_id: "rmsg_..." })` only after status shows failure.

## Health and failures

The pane reports:

- enabled/configured state;
- database integrity and schema version;
- paired and pending counts;
- failed delivery receipts;
- last-seen timestamps and blocked/revoked status.

Use these tool actions for deeper inspection:

```text
remote_peer({ action: "message_failures" })
remote_peer({ action: "message_status", message_id: "rmsg_..." })
remote_peer({ action: "list_peers" })
remote_peer({ action: "pending" })
```

## Recovery

- **Database integrity or migration failure:** stop Piclaw, preserve the scoped data directory, and restore a complete backup. Do not delete `state.db` silently.
- **Lost identity/private key:** install with a fresh scoped directory and re-pair. There is no legacy import or compatibility fallback.
- **Changed origin or TLS setup:** update External URL, restart, then ping peers. Re-pair if identity or trust state changed.
- **Stuck delivery:** inspect the stored receipt. Retry with the same idempotency key only if the original outcome is uncertain.

Back up `<PICLAW_DATA>/addons/remote-peer/` as one unit. The identity file and SQLite state must remain consistent.
