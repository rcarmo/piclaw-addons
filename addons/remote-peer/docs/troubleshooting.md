# Troubleshooting Remote Peer

## Pair request fails

- Confirm both add-ons are enabled and External URL is reachable from the other host.
- HTTPS is required unless both HTTP and private-network development overrides are explicitly enabled.
- Compare `/agent/addons/api/remote-peer/dashboard` health: database must be `ok`, external URL configured, and pending count should change.
- Private, loopback, link-local, credential-bearing, unresolved, or mixed public/private DNS targets are rejected by default.

## Pair confirmation fails

- Verify immutable fingerprints out of band.
- Check that each origin points to the correct instance and identity.
- Revoke stale peer records before re-pairing after identity rotation.
- The receiver revokes provisional trust if signed confirmation fails; retry with a new request.

## Message is queued but no timeline row appears yet

Core preserves normal queue semantics. `queue` and `auto` can remain follow-ups while the target chat is active; `steer` enters the active lane only when explicitly allowed. The signed receipt and add-on ledgers remain durable even when `row_id` is null.

Use:

```text
remote_peer({ action: "message_status", message_id: "rmsg_..." })
remote_peer({ action: "message_failures" })
```

## Alias is rejected

- The receiver must advertise the alias.
- The authenticated peer needs `named-agents` permission for that alias or `all-advertised` scope.
- Both the peer mode ceiling and alias mode list must allow the requested mode.
- Signed rosters intentionally omit unselected local agents and local mapping names.

## Opaque reply fails

Opaque reply capabilities are signed, peer-bound, and expire after seven days. Do not edit the `peer!reply.<token>` address. A capability is invalid after expiry, key rotation, wrong-peer use, or destructive data reset.

## Mediated work stays pending

This is expected until a local operator approves or rejects it. Both proposal and execute request types are mediated.

```text
remote_peer({ action: "work_inbox" })
remote_peer({ action: "work_status", request_id: "rwork_..." })
remote_peer({ action: "work_wait", request_id: "rwork_...", timeout_ms: 30000 })
```

Capability profile failures mean the requested labels exceed the local allowlist. Chain-loop/hop failures require a new chain or lower hop count.

## Result callback is delayed

Failed callbacks persist with bounded backoff: 30 seconds, 2 minutes, 10 minutes, then 1 hour. The startup worker retries due attempts. Operators can trigger:

```text
remote_peer({ action: "work_retry_callbacks" })
```

Unknown, duplicate, and conflicting callbacks are rejected and never overwrite a terminal request.

## Identity rotation is blocked

Revoke every paired peer first while the old key can still notify them. Then rotate with `ROTATE <current fingerprint>`, restart Piclaw, and re-pair. The prior identity is archived at mode `0600` under `backups/`.

## Database or migration error

Stop Piclaw and preserve the entire scoped add-on directory. Do not delete `state.db`. Restore the identity and database together from a consistent backup. Migrations are checksummed and create an online backup before upgrades.

## Uninstall/reinstall

Normal uninstall removes code/registrations but preserves `<PICLAW_DATA>/addons/remote-peer/`. Reinstalling the same package restores access to the existing identity/state. Destructive reset is a separate explicit operation; there is no legacy core-state import.
