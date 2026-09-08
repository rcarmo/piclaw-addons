# Operator guide

See [the main README](../README.md) for client-ID and ticket pairing.

Start with two newly enabled instances. Enable Internet address lookup explicitly for ID-only internet dialing, or exchange tickets. mDNS is separately opt-in. Compare the full client ID with the owner before accepting; a familiar instance name is not proof.

Use Settings to set aliases, advertise agents, grant receiver permissions and inspect failed delivery. Revocation immediately disables local acceptance. It also attempts to notify the remote; an offline peer may retain stale display state but cannot bypass local revocation.

Failed outbound messages retain their payload and message ID. Retry after connectivity returns. Do not create a new ID merely because an acknowledgement was lost. Unknown receiver outcomes require investigation, not blind resend.

Settings changes stop the old Iroh/discovery resources before creating new ones. This can interrupt in-flight requests; failed sends remain recorded. mDNS failures do not enable HTTP fallback or auto-pair anything.

Back up the entire `iroh-v1` directory while the instance is stopped or use a consistent SQLite backup. Retain the secret key with its database. Losing it changes the client ID. There is no migration from old Remote Peer state and no in-place compatibility rollback. Uninstall must preserve this data; destructive reset is a separately confirmed operator task.
