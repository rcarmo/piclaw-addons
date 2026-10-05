# Linux child confinement — inactive #160 continuation

The Linux x86_64 implementation runs real read/bash tools inside a disposable
filesystem and PID namespace. It does not expose the live workspace or silently
replace a requested tool profile with a prompt-only child. PR175/8096c00 and its
historical qualification remain unchanged.

## Boundary

`runConfinedProxyChild` requires a trusted host-supplied runtime manifest and exact
approved file exports. It copies only regular files into an empty root, then runs
a small non-setuid helper compiled from `confinement.c`. Missing helper, unsupported
platform, denied namespaces, bad grants or failed setup stop the operation. There
is no retry through the older unconfined launcher.

The helper uses unprivileged user, mount, PID, network, IPC and UTS namespaces:

- root contains copied runtime files, approved `/work` inputs, four basic devices,
  private `/proc`, and bounded ephemeral `/home` and `/tmp` mounts;
- root/runtime mounts are read-only; `/work` is either read-only or a writable
  private copy; no workspace/state/profile/keychain/provider socket directory is bound;
- all capability sets are dropped, NoNewPrivs is set, and an x86_64 seccomp filter
  denies namespace changes, mounts, ptrace/process memory, kernel keyring access,
  new network sockets, handle-based file opens and other privileged interfaces;
- private provider fds 3/4 are retained; other inherited descriptors are closed
  before child execution. The outer supervisor closes its copies of 3/4;
- the agent is PID 1 in its namespace. Normal agent exit or supervisor death ends
  that namespace, killing descendants even if they detach via `setsid`;
- parent-death signals cover supervisor and namespace init; the parent still
  awaits OS close and independent host raw-request settlement before cleanup.

The helper does not install services or require sudo. The regression harness uses
sudo only to put the entire test run in a separate loopback-only network namespace,
then drops back to the ordinary user with no capabilities. The actual sandbox
itself uses rootless namespaces and works without that test harness.

## Exact host interface needed

These values are trusted launch inputs, never tool arguments or child IPC:

```ts
{
  helper: string;          // host-provisioned non-setuid executable
  helperSha256: string;   // qualified architecture/build identity
  runtime: Array<{ source: string; target: string; sha256: string; executable?: boolean }>;
  files: Array<{ source: string; exportRoot: string; target: string; sha256: string }>;
  profile: 'read_only' | 'workspace_write';
  entrypoint: string;     // /app/... in captured runtime
  args?: string[];        // bounded nonsecret launch descriptor, never credentials
  scope: ChildRequestScopeV1;
  signal: AbortSignal;
  timeoutMs: number;
}
```

The host must:

1. Approve a finite file snapshot for the operation. Export files into a private,
   current-user-owned directory; do not grant the live `/workspace`, home, a broad
   repository directory or credential/state files by extension/name heuristics.
2. Provide a qualified read/bash runtime manifest and the exact SDK/child bundle,
   with hashes. The test helper discovers shared libraries only for fixed trusted
   system executables. Production must not run `ldd` on a child-selected executable.
3. Keep export/helper staging directories under host ownership until launch and
   cleanup complete. This is not a defence against an already compromised parent
   process or an unrelated malicious process running as the same host user.
4. Map the existing tool-profile approval explicitly to a filesystem policy.
   `read_only` restricts filesystem writes, not tool declaration: bash can be tested
   against a read-only snapshot. Production read-only tool profiles must still
   omit bash if that is their declared policy. Standard/full may choose writable
   snapshots but must disclose that no writes are propagated to the live workspace.
5. Retain current model/provider/tier/image/executable approvals, deadline, work,
   budget/account authority and raw settlement. Confinement grants none of those.
6. Define a separate approved output-file import/writeback protocol if needed.
   This implementation returns bounded text and discards filesystem modifications.

Source export traversal uses held directory descriptors, O_NOFOLLOW and regular-file
identity checks. Private export roots, non-writable-by-others paths/files, one hardlink,
size limits and SHA-256 are enforced. Runtime files also require exact hashes.
Helper bytes are verified and copied to a separate private executable capture;
replacing the original helper path cannot change the launched binary. Captured
helper and filesystem survive until both OS and host-scope cleanup complete.

## Qualification

Use the existing exact-public103 checker with
`PICLAW_DELEGATE_CONFINEMENT_TEST=1`. It must run with explicit isolated SDK/archive
paths, non-root, zero capabilities and loopback-only networking. CI enables the
same tests and compiles the C helper with `-Wall -Wextra -Werror`.

The confinement suite covers:

- actual host-path absence, runtime read-only enforcement, private temporary writes;
- copied read-only and writable inputs, with original files unchanged;
- network and provider-socket access denial; kernel-keyring/mount/userns probes;
- inherited extra descriptor and symlink escape attempts;
- symlink/hardlink/directory/socket/bad-hash/traversal/permission grant rejection;
- export-root rename after opening and helper replacement after verification;
- `setsid` descendant cleanup after normal init exit and killed supervisor;
- actual public Pi AgentSession read → bash → continuation through private pipes;
- host raw tail kept pending after child cancellation, with exactly one scope close.

Current local exact103 matrix: **54 tests / 385 assertions**, strict types, 1,002
matching public SDK files. Confinement-specific tests run rather than skip. Initial
smokes and namespace receipts are preserved in
`exports/delegate160-confinement-20261005/` on the development host.

## Unqualified / not activated

Only Linux x86_64 with working unprivileged namespaces, seccomp and close_range is
implemented. Other architectures/platforms fail explicitly. This is not a VM or
kernel-exploit boundary. CPU/memory/process-count/disk exhaustion limits need a
host-owned cgroup/resource policy; process lifetime containment is qualified, but
denial-of-service resource containment is not.

Real persistent account locking, provider execution/accounting, installed startup
wiring and reviewed host export admission remain separate gates. MCP remains
`none`; no host socket or MCP credentials are exposed. No production package,
installation, restart, real-account operation, paid inference or Pi1.0.4 retarget.
