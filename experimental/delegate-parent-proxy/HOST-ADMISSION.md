# Host admission and resource-domain contract

This inactive slice binds a finite launch policy to an admitted invocation and an
explicit host resource provider. It does not implement a cgroup, mount quota,
service unit or production quota executor. Without a separately qualified provider,
production admission returns `UNSUPPORTED_DOMAIN` before staging or child launch.

Frozen PR175/8096c00 and PR177/60cff61 are unchanged. This contract continues from
PR177 in an isolated source branch; it is not exported or registered by Delegate.

## Trusted composition

```ts
const admission = createHostAdmission({
  mode: 'production',
  policy,                 // finite approved host manifest and exports
  provisioner,            // absent until independently qualified
});
const launch = admission.admit(capturedInvocation, coreScope);
const result = await launch.run(); // one use, no caller-selectable launch input
await launch.close();
```

Only trusted core startup/invocation code may construct the factory and call
`admit`. `capturedInvocation` comes from an already-admitted tool call and contains
add-on/work/chat/tool-call IDs, exact provider/model, deadline, signal and a
synchronous `authorise()` closure over that authority. No path, resource-domain ID,
account identity, quota value or policy arrives from IPC. Failed `admit` transfers
no ownership: its caller retains responsibility for `coreScope.close()`.

Successful `admit` copies and freezes plain identity/policy data, captures callback
identities, verifies the scope's exact model and MCP `none`, and owns scope cleanup.
A launch can run only once. Missing/foreign authority, revocation, expiry, repeated
launch, or unsupported provider modes stop admission. `authorise()` must not start
asynchronous work; accidental returned thenables deny execution and are still
tracked through cleanup.

## Finite export policy

`FiniteLaunchPolicyV1` contains:

- helper path and exact SHA-256;
- at most 128 runtime regular-file manifest entries (source, relative target,
  SHA-256 and executable flag), including Bun and the exact child entrypoint;
- at most 256 approved regular-file export entries (source, private exportRoot,
  relative `/work` target and SHA-256);
- an explicit filesystem profile, `read_only` or `workspace_write`;
- an explicit supported tool list containing `read`, `bash`, or both; no implicit
  extra tools or silent prompt-only fallback;
- `/app/...` entrypoint and at most 64 nonsecret arguments, each at most 8,192
  characters and collectively at most 32 KiB encoded;
- the resource limits below. Missing or zero limits fail validation.

The captured policy is a list of already-approved exports, not a glob, recursive
scan or filename-based secret detector. The host must approve content and provenance
before constructing it. The schema rejects unknown authority fields, path traversal,
source/export-root escape, conflicting targets and mismatched tool/FS profiles.
Actual source bytes must still pass PR177's private-owner/mode, descriptor traversal,
regular-file, one-hardlink, length and digest checks inside the provisioned domain.
Source directories, socket files and live workspace/profile/keychain directories
must not be mounted. Read-only filesystem policy does not itself make bash a
read-only tool; the approved tool list remains a separate restriction.

## Resource limits

All limits cover the complete descendant tree, including detached children:

| Field | Required enforcement |
|---|---|
| `cpuQuotaMicros` / `cpuPeriodMicros` | Aggregate CPU scheduling quota; positive and quota ≤ period |
| `cpuTimeMs` | Total accumulated CPU consumption ceiling, not merely wall-clock timeout |
| `memoryBytes` | Aggregate charged memory ceiling, including private tmpfs; swapping disabled |
| `pids` | Aggregate processes and threads, including namespace init and detached descendants |
| `writableBytes` | Hard aggregate writable/staging storage ceiling across work/home/tmp, including sparse and unlinked-open files |
| `writableInodes` | Hard count limit on created writable/staged filesystem objects |

The wrapper checks finite values and upper validation bounds; it cannot verify OS
installation. A returned provider tag or an injected test counter is not evidence
that a kernel limit exists. CPU/memory/PID controls alone do not bound writable
work-directory growth. No in-process polling monitor or post-spawn cgroup move
satisfies the before-child-code requirement.

## Provider interface and ordering

`HostDomainProvisionerV1.provision({ binding, limits, signal })` returns a
`HostOwnedTask<ProvisionedDomainV1>`. The provider must create or claim an explicit,
exclusive host-provisioned resource domain under operator-approved ownership.
There is no default domain path, service name or inherited current-Delegate cgroup.

1. Before allocation, the wrapper checks captured authority and deadline.
2. `provision.result` must yield every allocated handle even after cancellation,
   or release the allocation itself before rejecting. It must never hide a late
   allocation behind a delivery-only abort race.
3. The wrapper waits for both the allocation result and its original `settled`
   obligation, then rechecks authority. No snapshot, command or child is executed
   before setup completes.
4. `domain.execute({ binding, policy, scope, signal, authorise })` owns staging,
   filesystem preparation and launch **within that existing domain**. It must
   enforce the captured policy and recheck `authorise()` immediately before child
   code. It must not transmit host binding IDs, resource paths or credentials to
   the child. The guarded scope rechecks authority before provider requests.
5. The wrapper retains `execute.result` and `execute.settled`, and separately calls
   `domain.close()` and `scope.close()`. Close cancels outstanding tasks, stops
   admission, drains all descendants and provider work, and releases storage only
   when both obligations finish. No deadline can substitute for a raw-cleanup ACK.
6. Failed close/settlement/cancellation is sticky: host shutdown rejects and retains
   the failed launch for quarantine rather than reporting successful release.

Cancellation, expiration, host shutdown, reentrant callbacks and late allocation
results converge on the same idempotent closes. At most 64 launches are retained
per factory; the host should instantiate factories within a controlled lifecycle.
The absolute deadline includes provisioning and execution. A qualified provider
must check it during synchronous/batched staging too; JavaScript timers do not
interrupt a blocking file operation.

## Relationship to PR177

The existing `runConfinedProxyChild` stages using parent temporary directories and
launches through ordinary `spawn`. Merely wrapping that function in a promise does
**not** satisfy this resource contract. A real provider needs a pre-enrolled worker
or equivalent atomic launch primitive, quota-backed staging/work storage, and
verified descendant kill/drain. It may reuse PR177's namespace/seccomp/helper logic
inside that boundary after qualification. No such adapter is implemented here.

The host must also define how a late worker returns bounded text and whether any
output files may be imported. This contract returns text only and does not write
back arbitrary filesystem changes. MCP remains `none`; requests for MCP or other
tool profiles require a separate supported contract, not a downgrade.

## Evidence and limits

Tests inject `synthetic-test-domain-v1` only in `offline-test` mode. Production
rejects that provider kind; mutating the provider afterward cannot relabel a factory.
The tests exercise immutable capture, admission, exact-once launch, before-setup
ordering, cancellation/deadline/revocation, reentrant shutdown, late handles, raw
settlement and sticky cleanup faults. They create no cgroups or services, spawn no
quota workers and prove no hard CPU/memory/PID/storage ceiling.

A trusted host can label its own provider as qualified, so deployment still requires
an independently reviewed OS implementation and exact evidence. This module is not
a security boundary against malicious host code or a compromised same-UID parent.
Production credential migration, all-writer authority, public startup binding,
provider accounting, packaging and rollout permission remain separate gates.
