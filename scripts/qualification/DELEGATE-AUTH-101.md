# Pi 1.0.1 synthetic child-auth qualification

This fixture qualifies the public provider/private-pipe seam against the published Pi 1.0.1 packages. It does not change production Delegate or close parent issue #160.

## Evidence

The target is upstream commit `a7229ddc21810d6245105978033b7df645ecc2f7`. The test checks the SHA-512 registry integrity of `pi-ai-1.0.1.tgz` and `pi-coding-agent-1.0.1.tgz`, then compares 561 installed JavaScript/JSON files with those archives. It uses the published `dist/bundle/cli.js` entrypoint and public SDK/provider APIs.

The fresh run on 4 October 2026 used Bun 1.4.2:

| Case | Auth resolutions | Child observations | Result |
|---|---:|---:|---|
| OAuth rotation | 2 | 2 | Refreshed once; second request saw new auth |
| API key/provider environment | 2 | 2 | Scoped synthetic environment reached provider |
| Logout between requests | 2 | 1 | Second request failed closed |
| Missing auth | 1 | 0 | First request failed closed |
| Pipe disconnect | 2 | 1 | Second request failed closed |
| Forced child termination | 2 | 1 | SIGKILL; no second response |

The guarded matrix passed **1 test / 580 assertions in 6.80 seconds**. The separate receipt validator passed **1 test / 11 assertions**, checking source fingerprints, the saved raw-log hash and the recorded scope. Exact-1.0.1 fixture types and five repository compatibility type projects passed. Repository compatibility passed **272 tests / 13 opt-in skips / zero failures**, with 1,607 assertions in 27.07 seconds; the integration was qualified separately, not counted as an ordinary-suite pass. Historical 1.0.0 files and receipts are unchanged.

The integration test requires a different network namespace with only loopback, a non-root UID, zero effective/permitted/bounding/ambient capabilities and `NoNewPrivs=1`. The parent and child run with explicit minimal environments, isolated HOME/profile/workspace paths, no saved sessions and synthetic credentials. Fetch instrumentation recorded no attempts; the namespace provides the external-egress barrier. Fetch counters are not a complete accounting of socket attempts. Capability dropping is not a filesystem sandbox.

## Reproduce

Prepare a disposable consumer whose Earendil packages are pinned to 1.0.1 and byte-identical to the registry archives. Supply absolute paths; do not use production profiles or credentials. Run from the repository root on Linux with Bun, `sudo`, `unshare`, `ip`, `setpriv` and `timeout` available:

```bash
consumer=/absolute/path/to/disposable-101-consumer
archives=/absolute/path/to/verified-101-archives
sudo -n unshare --net /bin/sh -c '
  ip link set lo up && exec setpriv \
    --reuid="$1" --regid="$2" --clear-groups \
    --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
    env -i PATH=/usr/local/lib/bun/bin:/usr/bin:/bin HOME=/nonexistent \
    PICLAW_E2E_DISPOSABLE=1 PICLAW_DELEGATE_AUTH_CONSUMER="$3" \
    PICLAW_DELEGATE_AUTH_ARCHIVES="$4" PICLAW_DELEGATE_PARENT_NETNS="$5" \
    timeout --kill-after=2s 45s nice -n 10 "$6" --no-env-file test \
    scripts/qualification/delegate-auth-101.test.ts
' auth-namespace "$(id -u)" "$(id -g)" "$consumer" "$archives" \
  "$(readlink /proc/self/ns/net)" "$(command -v bun)"
```

Ordinary `bun run test:earendil-compat` runs the saved receipt validator but skips the integration unless the disposable inputs are supplied. Type-check the parent/child against the exact 1.0.1 consumer rather than the repository's older compatibility packages.

## Limits

- Only a synthetic provider and explicit fixture extension ran. No live credentials, login, provider network request or inference was used in the matrix.
- Production Delegate still has its separate credential/profile/environment integration gap. This fixture does not remove ambient child environment inheritance.
- The two public auth lookups are not an atomic logout-to-dispatch guarantee.
- Forced termination is not proof of cooperative request cancellation.
- Custom/ambient providers, selected MCP engine, budget enforcement and real-account parity need separate qualification.
- This is source/test evidence, not installed-runtime, canary, soak or rollout acceptance.

See [the receipt](fixtures/child-auth-101.json) and [the raw matrix log](fixtures/child-auth-101.log).
