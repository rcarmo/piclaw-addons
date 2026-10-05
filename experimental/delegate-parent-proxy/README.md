# Delegate parent-provider proxy — inactive implementation

This directory implements the initial bounded IPC consumer for add-ons issue #160.
It is **not registered or imported by Delegate**, and is outside published add-on
packages. No real credential lookup, inference, installation or production runtime
activation occurs here. Qualification registers a synthetic public provider in a
separate child and runs a disposable AgentSession.

The proposed public core type contract is a structural copy of
`runtime/src/addons/child-request-contracts.ts`, SHA-256
`c8ebf5520c122d5d7ba263b852436c6b2c0a10f0fe13e3973977abcf64e236ea`.
Core implementation/qualification is separately owned. In the proposed design,
the parent executes provider requests; no API keys, headers, environment,
provider/account/work IDs or spending authority arrive from the child.

**Production blocker:** the core host owner reports that public Pi 1.0.1 stream
terminal events and `result()` do not establish raw provider-task/auth settlement.
The real adapter needs a public settlement seam or a supported-provider plan
proven to own and drain every tail. Do not substitute `result()`, iterator end,
HTTP-body completion or a timeout race for `stream.settled` / `scope.close()`.
The synthetic scope deliberately models a separate settlement promise; passing
these tests does not prove the real SDK can fulfil it.

## Wire v1

Four-byte big-endian length prefix, strict UTF-8 JSON. Request types: `start`
(`id`, public Context, allowlisted options) and `cancel` (`id`). Response types:
`event`, finite-code `error`, `settled`, each bound to one request and sequence.
Limits: 4 MiB frame and pending child event bytes, 16 MiB aggregate response,
8,192 response frames, JSON depth 32, 100,000 JSON nodes, 64 requests per session.
Invalid frames permanently close the channel. No raw body is reflected in errors.

One active request remains leased until the parent reports raw provider/auth-tail
and accounting settlement. Child iteration may see a terminal before settlement;
no next request is admitted while raw work or unread buffered events remain.
Cancel stops event delivery, signals the parent and awaits settlement. Parent EOF
cancels admission/output and awaits scope close. An uncooperative tail can therefore
leave close pending; the owning runtime must track/quarantine it, not call it done.

Both directions have strict envelope/option validation. Context supports public
Pi 1.0.1 system, user, assistant and tool-result messages and tool declarations.
Child history containing private diagnostics, tool-result metadata/nested charges
or unsupported blocks fails explicitly. The future child provider wrapper must
project its SDK context into this subset before sending. The host still independently
validates the model, full context and options against its supported provider plan.

Output projection preserves the supported public event/message fields, drops raw
diagnostics/errorMessage and enforces the exact bound model (initial subset).
Provider errors map to finite codes. The host must still sanitise event content
before this adapter: arbitrary text cannot be reliably scrubbed of secrets without
owning their source. Initial MCP plan is `none`; required MCP must be denied by
scope creation. Deferred/custom provider execution is not qualified by these tests.

## Source modules

- `contracts.ts`: proposal types and transport limits; type-only public SDK imports.
- `framing.ts`: incremental framing and request-envelope/options validation.
- `validation.ts`: supported public Context validation and event projection.
- `parent-session.ts`: injected host scope, ordered/backpressured sends, cancellation
  and raw settlement lifetime.
- `child-session.ts`: bounded event consumption, request IDs/sequences and settlement.

Tests use in-memory transports and synthetic scope generators only. They do not
validate real account revocation, reservation enforcement, HTTP send gates or usage
attribution. Those remain core dependencies; #160 is not complete.

Use `scripts/qualification/delegate-proxy-103-check.ts` below to test against the
exact isolated Pi release. Repository compatibility dependencies are older; a bare
root test run cannot qualify the public Provider/AgentSession fixtures. Do not
import private core source or swap the live dependency tree for the test.

## Released Pi 1.0.2 assessment — 2026-10-05

The unchanged consumer passes strict checking against public Pi AI 1.0.2 types
(`skipLibCheck: true`). The focused suite passes 20 tests / 153 assertions,
including one additive regression for the sampling-field allowlist. The original
Pi 1.0.1 19-test / 146-assertion receipt is preserved.

Compared with 1.0.1, Context, message/content, event and reasoning declarations
are unchanged. The new `SamplingParams` alias replaces an equivalent record type;
`Model.samplingParamsByThinkingLevel` is model metadata. Neither it nor arbitrary
`samplingParams` may be supplied by the child. No wire/protocol implementation
change was needed. Existing subset restrictions, including string-only system
content and rejection of deferred replies, still apply.

`Models`, `EventStream` and lazy-stream declarations are byte-identical between
the two releases. Pi 1.0.2 supplies no separate public raw-task/auth-settlement
promise. Production wiring still needs the host settlement proof above.

Qualification used public declarations from the isolated core integration
worktree, verified against the released registry archive and its SHA-512 integrity.
Tests use synthetic streams with type-only SDK imports; provider runtime behaviour
and real auth were not exercised. The first type run caught a widened fixture
`version` literal; `satisfies ClientFrame` fixed it before the passing final run.

The host integration retains its standard shipped MCP wrapper. The proxy's
initial `mcp: 'none'` restriction applies only to child execution; native MCP parity
or wrapper removal is not a prerequisite for the core migration.

Local evidence: `/workspace/exports/delegate160-pi102-assessment-20261005/`
(`receipt.json`, `tsconfig.pi102.json`, declaration diff and test/type logs).
Consumer remains unregistered, uncommitted and unpublished; #160 is incomplete.

## Released Pi 1.0.3 assessment — 2026-10-05

The existing implementation and c8ebf552 contract pass strict checking against
public Pi AI 1.0.3 declarations (`skipLibCheck: true`). The synthetic suite passes
22 tests / 160 assertions. Two additive tests cover the `azure` provider identity,
unchanged `azure-openai-responses` API, Foundry's `openai-completions` API, and
rejection of legacy/foreign response identities under an exact `azure` plan.
These fixtures do not invoke Azure or a provider runtime.

The only change in `dist/types.d.ts` from 1.0.2 is the `KnownProvider` member:
`azure-openai-responses` becomes `azure`. Context, messages, options, events and
reasoning types are unchanged. The consumer preserves parent-bound identifiers
without aliases; no implementation or wire change was needed.

Public Models/event-stream/lazy declarations remain byte-identical. The release
includes an OAuth refresh-rotation fix, but no separate public raw-task/auth
settlement or account lease was established here. Production wiring stays blocked.
The core integration retains the standard shipped MCP wrapper.

Eleven package/doc/declaration files match the supplied 1.0.3 registry archive;
SHA-1 and SHA-512 integrity were rechecked locally at upstream commit
`d78dc83d633229d12f8b79631384c4c2717c399f`. All nine Pi 1.0.2 evidence files and
all ten pre-existing consumer TypeScript files are unchanged. No external request,
model spend, live auth, install, activation or restart occurred in qualification.

Local evidence: `/workspace/exports/delegate160-pi103-assessment-20261005/`
(`receipt.json`, `check.ts`, `tsconfig.pi103.json`, type delta and passing logs).
The old Pi 1.0.2 integration worktree was absent; comparison used the preserved,
hash-verified 1.0.2 archive. #160 stays incomplete and the consumer stays inactive.

## Public provider and process implementation — 2026-10-05 continuation

The consumer now includes a credential-free public `Provider` adapter, bounded
private-pipe writes and a Linux child-process owner. It is still not wired into
`addons/delegate/delegate.ts`, exported by its package or registered at startup.

- `provider.ts` projects supported transcript data, strips local tool-result
  details/charges and assistant diagnostics, rejects credential/authority options,
  and waits for the parent's `settled` frame before emitting a successful SDK
  terminal event. Error delivery may precede raw settlement; the parent retains it.
- `childAgentOptions` keeps public AgentSession's local callbacks/bookkeeping out
  of IPC. The initial child does not provide raw provider instrumentation callbacks,
  deferred requests, constrained tool choice or retries. The parent owns requests.
- `pipe.ts` allows at most two pending writes and bounded bytes, copies queued
  frames, applies stream backpressure, and closes on malformed input/abort/EOF.
- `owned-child.ts` starts Bun with `--no-env-file`, a private disposable profile and
  an explicit environment. It owns private fds 3/4, caps output, kills the process
  group on cancellation/deadline and leader exit, awaits OS close and host scope
  close separately, then removes only its profile. A raw host tail may keep close
  pending; no timer or process exit is used as a settlement acknowledgement.
- `fixture-child.ts` is test-only. It exercises public Models and an actual public
  AgentSession with a read-tool call and continuation, empty credential/model
  stores, no discovered resources, in-memory settings/sessions and denied fetch.

Current Context admission also supports system text blocks and exact public
`constrainedSampling` variants (`false`, JSON-schema strict prefer/require, grammar
variants). `true`, callbacks, unknown fields and malformed variants fail closed.
This supersedes the earlier string-only/boolean tool restriction; V1 types and
framing are unchanged. Core is expanding its validator to match.

Qualification is separate from this repository's older compatibility dependencies:

```sh
bun install --frozen-lockfile
# CONSUMER is an isolated public Pi 1.0.3 install; ARCHIVES contains both released
# pi-ai-1.0.3.tgz and pi-coding-agent-1.0.3.tgz. OUT must not exist.
sudo unshare --net --fork setpriv --reuid="$(id -u)" --regid="$(id -g)" \
  --init-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
  env -i PATH=/usr/bin:/bin HOME=/tmp "$(command -v bun)" --no-env-file \
  "$PWD/scripts/qualification/delegate-proxy-103-check.ts" "$CONSUMER" "$ARCHIVES" "$OUT"
```

The checker pins archive integrity, compares runtime/declaration inventories,
checks exact public types and runs the real-pipe/agent-loop suite in a non-root,
zero-capability, loopback-only namespace. It retains logs and source fingerprints.
CI has a dedicated `delegate-proxy-103` job; production packages are unchanged.
Local final gates: 40 tests / 283 assertions; strict public types; 1,002 matching
package/declaration/runtime files; compatibility 281 pass / 15 opt-in skips /
1,681 assertions; build + standalone 35 pass / 58 assertions. Five compatibility
type commands, catalog and pack checks passed. The first broad import run exceeded
its 120-second command deadline; the final 300-second run passed in 153 seconds.
See [INTEGRATION.md](INTEGRATION.md) for owner tasks and activation gates.

### Remaining integration requirements

Core owner @github accepted startup `childRequests` exposure, exact admitted-work
binding, full bounded Context validation, owned-task execution and account-generation
leases. Legacy provider implementations without owned tasks must fail closed.
The released 1.0.3 public SDK still cannot fulfil the host raw-tail requirement.

The minimal environment does not prevent built-in read/bash from opening files
accessible to the OS user. It is not a filesystem/network sandbox. This fixture
runs only trusted read calls in disposable data. Production needs an explicit
workspace/secret/tool confinement policy before granting child tools. Linux process
groups also cannot reclaim an intentionally detached process group; Windows and
hard orphan confinement are unqualified. MCP stays `none` and required MCP must
fail before launch. No credential-file isolation, real-provider auth/account/budget
parity, selected-MCP support or production readiness follows from these tests.

Historical failures are retained in local implementation evidence: fixture literal/
SDK-type corrections, a referenced grandchild preventing leader exit, the actual
agent loop exposing unsupported local option fields/constrained sampling, and a
TypeScript package export-path correction. Passing retries did not erase them.
