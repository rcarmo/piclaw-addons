# Pi 1.0.3 synthetic Delegate child qualification

The published Pi 1.0.3 CLI and public provider/private-pipe auth seam pass current offline qualification. Production Delegate credential/environment integration and the credential-free parent proxy remain incomplete. Smith's core upgrade is a separate verified operational receipt; this change does not install or activate the Delegate add-on.

Exact upstream release: `d78dc83d633229d12f8b79631384c4c2717c399f`. Bun 1.4.2 on Smith LXC; all profiles, workspaces and credentials are disposable synthetic fixtures. Historical [Pi 1.0.1 evidence](DELEGATE-AUTH-101.md) and its fingerprinted sources remain unchanged.

## Current artifact and execution evidence

- `cli-103.test.ts` checks SHA-512 registry integrity, equal selected file inventories and 76 matching manifest/bundle files. It resolves `package.json.bin.pi`, runs the actual published `dist/bundle/cli.js --offline --version`, verifies 1.0.3 and leaves profile/workspace empty. The version child has an independent ten-second kill bound. One integration test / 94 assertions passes.
- `delegate-auth-103.test.ts` verifies the two published archives and compares equal selected inventories plus 564 matching JavaScript/JSON payload files. Its parent and child exercise the actual public SDK and published CLI with a synthetic provider loaded as an explicit fixture extension. One integration test / 587 assertions passes.
- Both integrations run in a separate loopback-only network namespace as a non-root user with zero effective/permitted/bounding/ambient capabilities and `NoNewPrivs=1`. Minimal environments omit inherited live credentials. Fetch guards record zero attempts; network namespaces provide the external-egress barrier. Capability dropping is not a filesystem sandbox.
- Receipt validators bind current release, exact source fingerprints, raw-log hashes, expected scenario counts and limitations. Normal compatibility runs execute these validators and skip the opt-in integrations; skipped integrations are not passes.

| Synthetic auth case | Auth requests | Observations | Refreshes | Outcome |
| --- | ---: | ---: | ---: | --- |
| OAuth rotation | 2 | 2 | 1 | Second request sees rotated auth |
| API key/provider environment | 2 | 2 | 0 | Scoped environment reaches provider |
| Logout between requests | 2 | 1 | 0 | Second request fails closed |
| Missing auth | 1 | 0 | 0 | First request fails closed |
| Pipe disconnect | 2 | 1 | 0 | Second request fails closed |
| Forced child termination | 2 | 1 | 0 | SIGKILL; no second response |

The matrix checks synthetic sentinel absence from stdout/stderr, arguments/environment and fixture disk files. An unrelated synthetic credential stays in the parent. The child saves no JSONL session. Forced termination is not proof of cooperative request cancellation. Two auth lookups do not establish atomic logout-to-dispatch authority or raw provider/auth cleanup settlement.

Receipts: [CLI](../../addons/delegate/fixtures/pi103-cli-admission.json) and [auth](fixtures/child-auth-103.json). Each raw log is checked by its validator. Selected inventories exclude documentation/declaration files; the evidence does not assert a whole dependency-tree byte match.

## Reproduce

Prepare a disposable consumer pinned to `@earendil-works/pi-coding-agent` and `pi-ai` 1.0.3 with payloads matching the archived registry artifacts. For the auth integration supply absolute `PICLAW_DELEGATE_AUTH_103_CONSUMER` and `PICLAW_DELEGATE_AUTH_103_ARCHIVES` paths; for CLI supply `PICLAW_DELEGATE_103_PACKAGE` and `PICLAW_DELEGATE_103_ARCHIVE`. Set `PICLAW_E2E_DISPOSABLE=1` and `PICLAW_DELEGATE_PARENT_NETNS` to the outer namespace identity. Run through the repository isolation preloads inside `unshare --net`, bring loopback up, then drop UID/GID/groups/capabilities with `setpriv --no-new-privs` and use a bounded low-priority Bun test process. Never use the production auth/profile or inherited provider environment.

The exact-1.0.3 fixture TypeScript check uses the disposable consumer declarations (`strict`, `skipLibCheck`). The repository's compatibility dependencies remain at their historical target; no broad dependency retarget is made here.

## Retained failures and remaining work

The first new auth attempt failed its integrity check because the copied coding-agent SHA-512 string was wrong. That run never reached child execution. Review strengthened receipt fingerprint-key/run checks, exact selected inventories and asynchronous CLI deadline cleanup. A combined run before rebinding updated receipt counts failed the validators while its integrations passed; validators and fresh standalone integrations were then rerun. Initial TypeScript configuration used removed `baseUrl` and an unavailable `bun` type package; corrected exact-consumer config uses explicit paths and `bun-types`. These failures supply no approval or successful qualification.

The current production child launch still inherits ambient parent environment, and the production parent host is unregistered. Public raw executing-task/auth settlement and account-generation leases are absent from exact Pi 1.0.3. Do not implement `settled` as an alias for `result()`, iterator completion, HTTP-body completion or a timeout. Real provider/auth parity, budget/selected-MCP enforcement, fresh account authority, matching immutable core/add-on artifacts, sole-owner and orphan-process cleanup require separate qualification. No live login, account mutation, provider spend, add-on install/restart or activation occurs in this slice.
