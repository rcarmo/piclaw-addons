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

- Full repository suite after review fixes: 498 pass / zero fail, 3,005 assertions, including standalone package imports.
- Remote Peer focused tests: 20 pass / zero fail, 131 assertions, including lifecycle serialization, reply-epoch invalidation, mediated-result recovery and fixture ownership.
- Isolated Chromium Settings fixture: client-ID entry, default-off mDNS/lookup and Iroh enable/disable passed; no live Piclaw target.
- Two ephemeral endpoints using n0 address lookup paired with bare client IDs, mDNS off, and pinged successfully. Both reached the EU n0 relay; selected data path was direct on the same host.
- Extracted 0.3.0 archive installed/imported with prebuilt native dependencies and lifecycle scripts disabled. No legacy HTTP modules were packaged.
- Remote Peer/root compatibility typecheck, catalogue validation and diff whitespace checks passed.

Further acceptance evidence:

- Real two-device mDNS: Smith LXC (`192.168.1.152`) and disposable `/tmp` process on VM 900 (`192.168.1.236`) joined `224.0.0.251`; Smith discovered the VM ID/address, sent a pairing request, VM accepted through its loopback control API, and one message was received. A raw multicast probe also passed bidirectionally. Both existing Piclaw services remained active; all temporary VM/local state was removed.
- Forced relay: two containers ran on separate Docker networks. Both established the explicit EU n0 relay. Each namespace rejected UDP to the other endpoint's advertised direct address. Pairing and one message passed with Iroh reporting selected path `relay`; receiver count was one. Containers, networks and roots were removed by the fixture trap.
- Full isolated Settings pairing: pasted ID and ticket, recipient approval and restricted policy edit passed.
- Fresh and paired Settings screenshots were generated from actual temporary Iroh state.
- Independent read-only review identified lifecycle races, unbounded shutdown, reply-token epoch revival, mediated-result recovery and fixture ownership issues. Dedicated fixes/regressions cover them. Core shutdown API/deadline PRs #1285/#1288 merged green; exact add-on follow-up-head re-review remains required before merge.

Not yet live-verified: a custom authenticated relay and the full add-on installed in a complete disposable Piclaw Settings UI. Custom relay map and keychain reference handling have unit/type coverage. Previous HTTP release evidence was removed because it does not validate this protocol.
