# Remote Peer 0.1.0 two-instance E2E matrix

Date: 2026-07-28

## Fixture

Two real Proxmox microVMs on node `borg` ran the same Piclaw `origin/main` source build and the same `@rcarmo/piclaw-addon-remote-peer` 0.1.0 release candidate.

| Peer | VMID | Address | State |
|---|---:|---|---|
| A | 900 | `192.168.1.78:8080` | existing microVM fixture, add-on data reset |
| B | 901 | `192.168.1.70:8080` | full clone of VM 900, add-on data reset |

Each instance used a separate fresh scoped identity and `state.db`. HTTP/private-network overrides were enabled only for this controlled LAN test.

## Results

| Case | Result | Evidence |
|---|---|---|
| Fresh identity/store | Pass | Distinct fingerprints; schema v5; no core-state import |
| Pair request/review/accept | Pass | Signed callback proof and confirm; both peers `paired`, epoch 1 |
| Restart persistence | Pass | Both services restarted; identity, peer, and schema state preserved |
| `peer!inbox` | Pass | Signed request delivered to core `web:default`; receipt row ID 847 |
| Idempotency retry | Pass | Same idempotency key returned byte-equivalent signed receipt; one timeline row and one inbound ledger row |
| `peer!@alias` | Pass | B advertised only `research → default`; receiver routed signed alias request without exposing local mapping |
| Queue / auto / steer | Pass | Receiver policy accepted all three only after named-agent and mode-ceiling approval; queue/auto followed active-lane semantics, steer entered active handling |
| Opaque reply | Pass | B received only `peer-a!reply.<capability>`; reply returned to A `web:default` with `in_reply_to`; no raw JID crossed instances |
| Mediated work | Pass | A proposal appeared in B inbox; B approved reviewed result with `analyze`; A persisted one completed callback |
| Callback outage/retry | Pass | A stopped during approval; attempt 1 failed, automatic worker delivered attempt 2 after restart/backoff; A completed request |
| Revoke | Pass | A local revoke epoch increment reached B; both records became revoked |
| Re-pair | Pass | Re-pair negotiated epoch 3 after bilateral revoke |
| Rotation guard | Pass | Rotation while paired returned an error; old-key revoke was required first |
| Key rotation | Pass | Previous identity archived mode 0600; fresh fingerprint active after restart |
| Reload | Pass | Runtime restart retained paired/state data and route/transport registrations |
| Uninstall | Pass | Package removal removed dashboard/route while preserving identity and `state.db` |
| Reinstall | Pass | Same fingerprint and schema v5 returned after reinstall |
| Retention/redaction | Pass | Automated maintenance test expires reply tokens, prunes delivered callback attempts/old audit rows, and nulls terminal prompts while retaining SHA-256 hashes |

## Additional automated gates

- focused add-on tests cover signatures, exact-body verification, SSRF, replay, trust epochs, pair state transitions, aliases, reply capabilities, policy ceilings, idempotency, work loops/allowlists, callback conflicts/retries, migrations, identity rotation, dashboard redaction, and startup registration;
- Earendil compatibility suite;
- standalone package import suite;
- catalog synchronization check;
- package dry-run and public tarball build;
- Settings Playwright flow and microVM screenshot.

## Fixture cleanup

VM 900's original portable service command and Cheapskate fixture were restored after the Settings screenshot test. The final two-instance release test uses reversible source-run systemd drop-ins. VM 901 is disposable and must be destroyed after release verification. Neither peer is the production Smith instance.
