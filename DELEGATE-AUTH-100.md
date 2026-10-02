# Pi 1.0.0 Delegate child-auth qualification

Production Delegate still inherits its existing child environment and profile. The files in `scripts/qualification/` are inactive synthetic fixtures; no production entrypoint imports them. They investigate a public request-time authentication route for #160 without copying live credentials or changing current delegation.

## Public boundary under investigation

A child CLI can explicitly load an extension under `--no-extensions -e <path>`. Pi awaits extension factories and registers their providers before model selection. A native `Provider.auth.apiKey.resolve()` can ask the parent for each request's auth through anonymous inherited pipes; the parent keeps a fixed provider/model binding and calls the public `ModelRegistry` facade.

`getApiKeyAndHeaders()` alone is insufficient to establish configured auth: its compatibility-header path can return `ok: true` without credentials. The fixture first checks `getProviderAuth()`, then gets model-composed key, headers, base URL and environment. These are two public resolutions, not an atomic authorisation/dispatch transaction. A production design must address policy revocation and logout between them. Previously issued credentials or dispatched HTTP requests cannot be retracted by deleting the parent credential.

The child has no auth-file copy or refresh token. Its synthetic provider implements the same request interface solely to observe resolved request values. This does not qualify replacing arbitrary real provider implementations. Native/custom stream functions, model filtering, endpoint logic and ambient credentials may depend on non-transferable state. Bedrock IAM, Vertex ADC and other ambient flows need separate treatment. A full parent request/stream broker would avoid transferring tokens but requires a larger event/cancellation protocol.

## Fixture scope

The parent creates a public `ModelRuntime` with `credentials: new InMemoryCredentialStore()`, no models file and no network refresh. It creates one synthetic OAuth provider and one unrelated synthetic credential. A copied child extension registers only the fixture model; a tool boundary lets the parent expire/remove credentials between two model requests.

The exact 1.0.0 run passed these six synthetic cases:

- OAuth expiry between requests invokes synthetic parent refresh and stores rotated tokens; the child observes fresh key/header/base URL values.
- API-key auth transports non-empty provider-scoped environment values.
- Public `logout()` between requests prevents the second stream while preserving the unrelated credential.
- Initially absent auth prevents every stream.
- Closing the broker pipe causes a terminal auth error.
- Forced process termination while awaiting auth stops the child. This is process containment, not cooperative request-cancellation evidence.

The fixture parses JSONL terminal assistant events and `agent_settled`; process exit zero alone cannot prove success. It checks secret sentinels in argv/environment, stdout/stderr and profile/workspace/home/tmp files. The runner and all CLI descendants share a killable process group. Deadlines bound child/IPC waits. Parent fetch calls are counted; a child preload records every fetch attempt to a test-owned file. A separate loopback-only network namespace blocks external egress.

The test runner's standard preload owns temporary paths; the parent/CLI receive explicit temporary paths and a minimal environment. This is not a filesystem sandbox or a malicious-child security boundary. Model tools, inherited descriptors and same-UID access require separate production threat review.

## Evidence state

An earlier two-case scratch preflight passed synthetic API-key rotation and simulated logout. It used a flag to make auth unavailable; it did not exercise OAuth refresh or the public logout operation. Its first attempt used the wrong `credentialStore` option, attempted the default auth store under `/nonexistent`, and failed with EACCES before child execution. Changing to the public `credentials` option fixed that setup error. Neither scratch result qualifies the expanded fixture above.

Source review found and corrected initial fixture weaknesses: raw substring matching of JSON errors, misleading cancellation naming, omitted home/tmp scans, parent-only fetch counts and no non-empty env case. The corrected exact-1.0.0 fixture passed one integration test with 573 `expect()` calls in 7.13 seconds on Bun 1.4.2. Public package JS/JSON comparisons covered 560 files across pi-ai and pi-coding-agent, both from integrity-verified archives. Strict types passed against that exact consumer. Independent follow-up review of terminal event interpretation and process-group cleanup found no blocker; a broader follow-up timed out and is not approval.

After moving every fixture outside the published add-on directory, the final receipt plus fresh six-case integration passed two tests / 582 `expect()` calls in 6.83 seconds. The repository compatibility suite passed 260 tests / 1,545 `expect()` calls with 11 opt-in skips. Exact fixture/wrapper strict types and catalogue checks passed. Two final compile setup errors (`--ignoreConfig` for explicit file compilation and a typed receipt-hash map) were corrected before execution; they are not behavioural failures.

The [recorded receipt](scripts/qualification/fixtures/child-auth-100.json) pins the parent/child fixture hashes and synthetic results. It does not promote this test route into production or qualify real-provider behaviour. The ordinary receipt test detects fixture/receipt drift; opt-in execution is still required for fresh behaviour evidence.

## Reproduction inputs

Run `scripts/qualification/delegate-auth-100.test.ts` under the repository preload, inside a separate loopback-only Linux network namespace with capabilities dropped. Supply only disposable qualification paths:

- `PICLAW_E2E_DISPOSABLE=1`
- `PICLAW_DELEGATE_AUTH_CONSUMER`: exact 1.0.0 consumer root with `node_modules`
- `PICLAW_DELEGATE_AUTH_ARCHIVES`: directory containing pinned `pi-ai-1.0.0.tgz` and `pi-coding-agent-1.0.0.tgz`
- `PICLAW_DELEGATE_PARENT_NETNS`: parent namespace identity captured before entering the isolated namespace

The test verifies archive integrity and published JS/JSON equality before running the actual packaged CLI. Without explicit inputs it skips. New runtime qualification is Bun-only. No live accounts, private MCP report, provider network calls, production installation or release are part of this work.

## Remaining integration decisions

- Production Delegate must retain operator/provider/model/tier/image/budget checks immediately before an attempt and on broker requests. This fixture does not wire those policies.
- Auth is resolved twice per broker request through the public facade. Concurrent logout, slow resolution and session replacement need explicit fencing; only between-request logout is measured here.
- Credential bytes cross a private inherited pipe into child memory. Child tools and same-UID processes are not sandboxed. A broker does not make untrusted model-executed shell commands safe.
- Child environment/profile isolation, discovery, caller/model binding and selected MCP engine must be implemented together to avoid breaking or silently widening approved workflows. Ambient cloud credential chains and custom request implementations need separate admission.
- The forced-termination scenario demonstrates bounded process cleanup only. Request abort propagation, late auth replies, cross-process refresh and provider-side revocation need dedicated fixtures.

All fixtures, tests and receipts live outside `addons/delegate/`, so the public Delegate tarball is unchanged. No add-on version or production catalogue entry changes in this qualification slice. The root test-development dependency pins retain their historical scope; the opt-in runner uses an explicitly supplied exact 1.0.0 consumer.
