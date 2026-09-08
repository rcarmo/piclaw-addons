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

This is not a sandbox for remote tool execution: no such execution is provided. Both proposal and execute-labelled work require local review and a supplied result.

Known crash boundary: an inbound `delivering` record with no receipt is ambiguous after a crash. The implementation refuses automatic redelivery, preventing duplicate agent work at the expense of requiring manual investigation. A completed message receipt is returned on normal retry.

No old database migration, compatibility mode, trust import or automatic deletion of installed legacy data is performed.
