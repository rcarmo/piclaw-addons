# Mediated remote work

Remote Peer provides durable cross-instance work requests without granting a remote peer direct tool or execution access. Every inbound `proposal` and `execute` request enters the same operator-mediated pending state.

## Lifecycle

1. `remote_peer({ action: "work_send", ... })` stores an outbound request with the origin chat/thread, requested capability profile, capability identifiers, and chain metadata.
2. The add-on sends a signed request to `/api/addons/remote-peer/v1/proposal` or `/execute`.
3. The receiver authenticates the peer signature, validates the profile allowlist and chain limit, rejects loops, and stores a pending inbound request.
4. An operator inspects `work_inbox` and either:
   - approves with a reviewed result plus an allowed-capability subset; or
   - rejects with a reason.
5. The receiver stores the decision atomically and sends a signed result callback.
6. The origin accepts one callback, persists completion, and queues the result into the originating chat when that context is available.
7. `work_status` and `work_wait` remain available across restart/reconnect.

`request_type: "execute"` is a protocol compatibility shape, not a short-circuit authorization. It is still pending until an operator supplies the reviewed result.

## Tool actions

```text
remote_peer({
  action: "work_send",
  peer: "lab",
  prompt: "Review this deployment plan.",
  request_type: "proposal",
  capability_profile: "restricted",
  capabilities: ["analyze"]
})

remote_peer({ action: "work_status", request_id: "rwork_..." })
remote_peer({ action: "work_wait", request_id: "rwork_...", timeout_ms: 30000 })
remote_peer({ action: "work_inbox" })
remote_peer({ action: "work_approve", request_id: "rwork_...", result: "Reviewed result", capabilities: ["analyze"] })
remote_peer({ action: "work_reject", request_id: "rwork_...", reason: "Not approved" })
remote_peer({ action: "work_retry_callbacks" })
remote_peer({ action: "work_profiles" })
remote_peer({ action: "work_set_profile", capability_profile: "research-only", capabilities: ["research", "summarize"], max_chain_hops: 2 })
```

## Capability policy

Capability identifiers are declarative review labels, not executable tools. The built-in `restricted` profile allows:

- `summarize`
- `analyze`
- `research`

An inbound request is rejected if any requested capability is absent from the selected profile. Approval may reduce that set but cannot add capabilities. Profiles also set a maximum chain hop count (0–8).

No profile can grant shell, file mutation, scheduling, secrets, model switching, or direct Piclaw tools because the add-on does not invoke those tools for remote requests.

## Chains and loops

Each work request carries a chain ID and hop count. The receiver rejects:

- hop counts at or above the selected profile limit;
- a second non-terminal inbound request using the same chain ID;
- malformed or out-of-range chain metadata.

This prevents recursive peer forwarding from creating a live loop. Multi-hop execution is not implemented.

## Callbacks and retry

Result callbacks are signed and bound to the paired peer's stored origin. Unknown callbacks return `404`. Duplicate or conflicting callbacks return `409`; neither can overwrite a completed request.

Failed callbacks are recorded in `callback_attempts` with bounded backoff (30 seconds, 2 minutes, 10 minutes, then 1 hour). The startup worker retries due callbacks every 30 seconds. Operators can also run `work_retry_callbacks`.

## Recovery and operator review

Pending/complete requests and callback attempts live in the dedicated add-on database, so status/wait survive Piclaw restart. The Settings/status payload reports pending work and due callback retries. Operators should verify:

- authenticated peer and immutable fingerprint;
- full prompt and chain metadata;
- requested profile/capabilities;
- reviewed result or rejection reason.

Do not approve a request merely because the peer is paired. Pair identity, messaging permission, and work approval are separate controls.
