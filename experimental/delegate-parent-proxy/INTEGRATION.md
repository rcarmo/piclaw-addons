# #160 host integration requirements

The consumer is implemented and tested with public Pi 1.0.3 objects and a synthetic,
task-owning host. Production is disabled. The standard Delegate package is unchanged.

## Core owner: @github

Core accepted these tasks on 5 October 2026:

1. Publish the existing `ChildRequestsApiV1` under `__piclaw_runtime.childRequests`.
   Register the add-on owner at startup and bind each scope to the exact admitted
   tool invocation, work/chat, model, deadline and signal. Private-pipe callbacks
   must use the captured invocation, never ambient callback ALS identity.
2. Keep the default host unset. A scope is unavailable until a qualified executor
   exists. No legacy-provider or `result()` fallback.
3. Admit bounded public Context data: tool declarations, system text blocks,
   toolsAdded/toolsRemoved, user/tool-result text and image blocks, and public
   constrainedSampling variants. Reject callbacks and authority fields. Schema
   admission does not grant host-side tool execution.
4. Supply a real executing-task lifetime for auth and provider work. Proposed
   public handles expose `{ result/events, settled, cancel }`, with settlement
   tracking installed before any work starts. Cancellation can stop delivery
   promptly but raw settlement waits resolver/refresh, credential-store commit,
   provider execution/finally and response cleanup. A rejected delivery, terminal
   event, iterator end, HTTP-body completion or timeout cannot substitute.
5. Opt providers into owned tasks. Composed wrappers must propagate ownership.
   Legacy/custom providers without the capability are unsupported. A public
   stream factory cannot retroactively discover a provider's hidden async tasks.
6. Bind an account generation and dispatch lease to the captured provider/model.
   Logout/replacement invalidates the lease. Define same-account refresh rotation
   separately. Recheck the lease and budget reservation at the sole outbound
   dispatch; classify already-dispatched interrupted work as unknown until reconciled.
7. Apply existing host reservation/accounting, no-retry HTTP policy, source/model
   agreement, global teardown and recovery. Scope.close owns all raw tails even
   after the child exits; no child value is an authoritative usage/account identity.

These are core/upstream changes, not APIs assumed to exist in released Pi 1.0.3.
The consumer V1 types remain unchanged.

## Add-on owner: @addons

Implemented in this directory:

- Bounded v1 frames and parent/child state machines; exact model identity and
  finite errors, no secret-bearing error diagnostics, one request until raw ACK.
- Public Provider adapter and a separate trusted AgentSession option projection.
  Raw provider instrumentation, arbitrary sampling, deferred execution and retries
  are unsupported. Successful terminal delivery waits for the parent ACK.
- Fixed private pipes with backpressure and bounded queued bytes.
- Linux Bun launcher with an explicit environment, `--no-env-file`, private profile,
  bounded output, process-group termination, OS close and independent scope close.
- Real public AgentSession → read tool → second request → final response test.
- Exact archive/type qualification in an offline non-root/cap-zero namespace.

Remaining before production wiring:

- Consume and qualify the exact core startup/invocation/executor implementation;
  test account rotation/logout dispatch races, cap rejection, shared accounting,
  raw cancellation and crash reconciliation end to end.
- Bind the launch to the existing approved candidate/CLI identity and total deadline;
  preserve automatic/explicit tier, image, provider, exclusion and response-model
  gates. Never fall back to the old ambient-credential child on denial.
- Stage a nonsecret bounded launch descriptor and prompt/attachments without
  serialising provider routes, headers, credentials or arbitrary module paths.
- Restrict tool access. The child shares its OS user's filesystem permissions;
  changing HOME does not prevent `read`/`bash` from reading the live profile.
  Either use a reviewed filesystem/process sandbox for supported tools, or offer
  an explicitly selected prompt-only lane with no tools and no resource discovery.
  Do not silently turn a requested standard/read-only/full profile into no-tools.
- Require a sole-owner cleanup strategy beyond process groups for tools that can
  daemonise or detach; Linux cgroup/job containment and Windows behaviour need
  separate qualification. The current Linux fixture kills same-group grandchildren.
- Negotiate MCP explicitly. V1 is `none`; deny required MCP before launch, never
  infer adapter access from the retained standard host MCP wrapper.
- Independently review and publish, then obtain separate rollout/canary permission.
  A source PR does not authorise live auth, paid inference, installation or restart.

## Finite plan decision

A prompt-only child removes the built-in-tool filesystem/orphan surface, but it
still needs the real parent auth/account/reservation/owned-task executor. The
current public Provider API cannot prove raw settlement even for a builtin by
watching its HTTP response. No new credential-forwarding implementation is proposed.

A broad read/bash/tool lane requires confinement before production. The isolated
read fixture is useful integration evidence, not a proof of that confinement.
