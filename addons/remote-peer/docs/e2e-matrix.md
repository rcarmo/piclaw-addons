# Iroh implementation evidence

Local validation uses Bun 1.4.1, owned temporary state and explicit loopback sockets. No installed Piclaw state is read or modified. mDNS tests use injected fake services, not LAN advertisements.

Passing development checks:

- checksummed client IDs and strict legacy-setting rejection;
- fresh empty state, legacy-file sentinels unchanged, key persistence and permissions;
- real two-endpoint loopback Iroh pairing, explicit approval and ping;
- receiver-owned named-agent/mode/file policy, binary hashes and opaque replies;
- completed receipt deduplication, restart identity and revocation;
- signed-envelope tamper/replay/time/identity checks;
- wrong ALPN, ticket-ID mismatch and malformed/oversized frames;
- mDNS default-off, toggle cleanup, candidate limits, expiry and interface record filtering;
- direct Settings/transport registration with no peer HTTP routes.

Additional local evidence (Bun 1.4.1):

- Full repository suite: 492 pass / zero fail, 2,973 assertions, including 27 standalone package imports.
- Remote Peer focused tests: 14 pass / zero fail, 99 assertions.
- Isolated Chromium Settings fixture: client-ID entry, default-off mDNS/lookup and Iroh enable/disable passed; no live Piclaw target.
- Two ephemeral endpoints using n0 address lookup paired with bare client IDs, mDNS off, and pinged successfully. Both reached the EU n0 relay; selected data path was direct on the same host.
- Extracted 0.3.0 archive installed/imported with prebuilt native dependencies and lifecycle scripts disabled. No legacy HTTP modules were packaged.
- Remote Peer/root compatibility typecheck, catalogue validation and diff whitespace checks passed.

These checks do not prove internet-separated NAT traversal, forced relay-only paths, real multi-device mDNS, authenticated custom relays, or all Settings pairing controls in a full installed Piclaw UI. Those remain explicit validation gates. Two delegated read-only reviews timed out; neither is counted as a review pass. Previous HTTP release evidence was removed because it does not validate this protocol.
