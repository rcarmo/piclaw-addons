# Iroh security boundaries

The Iroh endpoint key is the sole fresh client identity. QUIC authentication and signed application envelopes use that key; there is no legacy key mapping or imported trust.

- Pair requests require explicit operator initiation/acceptance. Discovery only suggests candidates.
- Default scope: inbox-only, queue mode, no files. Wider permissions require confirmation.
- Signed messages bind sender, recipient, request ID, operation, timestamp, nonce, body and binary hash. Transport receipts do not override receiver policy.
- The receiver applies permissions for every request, including on already connected streams. Revoked identities cannot send or request automatic re-pairing.
- Unpaired requests are rate limited; peers, discovery candidates, frame lengths, file sizes, request concurrency and pending outbound byte storage are bounded.
- State lives in a fresh `iroh-v1` directory. Key file mode is 0600. Native imports and local Settings registration do not enable networking by themselves.
- Local Settings is authenticated by Piclaw. Relay credentials are referenced by keychain name and never returned to the browser.
- mDNS may disclose the public client ID and configured instance label to the local segment only after opt-in. Public address lookup has a separate publication warning and defaults off.

Remote tool execution is unavailable. Both proposal and execute-labelled work require local review and a supplied result.

## Exact session access

Session advertisement requires request-scoped local authority. Settings submits an explicit local chat JID and incarnation with an advertised agent alias, public session alias and modes. The service checks that the target belongs to that local agent. Idle sessions remain valid; streaming activity is not an access condition.

Each peer needs a separate session grant and typed `ALLOW REMOTE ACCESS` consent. Named-agent and `all-advertised` policies never implicitly grant sessions. Effective modes intersect peer, advertisement and session-grant modes; `none` scope denies delivery. Files still require the peer's independent file permission.

Admission rechecks the exact incarnation. A stale or deleted lifetime rejects delivery without resolving another branch or falling back to a named agent. Older hosts without incarnation-bound admission report session targets as unavailable. Hiding a session removes all grants for that advertisement. Every advertisement/re-advertisement generates a fresh durable revision and clears prior grants, even for the same lifetime. Explicit policy writes validate the selected revision atomically, so an unchanged saved policy and pairing epoch cannot authorize a replacement using an old draft. Roster and receive checks reject revision mismatches; legacy grants without revisions do not acquire access through migration. Settings latches advertisement conflicts, clears typed consent and blocks Apply until Revert and fresh selection/confirmation. Session grants also participate in expected-policy comparisons and verified readback.

Known crash boundary: an inbound `delivering` record with no receipt is ambiguous after a crash. The implementation refuses automatic redelivery, preventing duplicate agent work at the expense of requiring manual investigation. A completed message receipt is returned on normal retry.

No old database migration, compatibility mode, trust import or automatic deletion of installed legacy data is performed.
