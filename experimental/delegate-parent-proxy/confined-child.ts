import { spawn } from 'node:child_process';
import { confinementCommand, stageConfinement, type ApprovedFileExport, type ApprovedRuntimeFile } from './confinement.ts';
import { runOwnedProxyChild } from './owned-child.ts';
import type { ChildRequestScopeV1 } from './contracts.ts';

/** Host-only entry. Missing namespace/helper/grants fail; never retry unconfined.
 * Returned output is bounded child text; filesystem changes remain in a discarded
 * snapshot. Publishing generated files requires a separate approved export policy. */
export async function runConfinedProxyChild(input: {
  scope: ChildRequestScopeV1;
  helper: string;
  helperSha256: string;
  runtime: readonly ApprovedRuntimeFile[];
  files: readonly ApprovedFileExport[];
  profile: 'read_only' | 'workspace_write';
  entrypoint: string;
  args?: string[];
  signal: AbortSignal;
  timeoutMs: number;
}) {
  let snapshot: ReturnType<typeof stageConfinement> | undefined, launch: ReturnType<typeof confinementCommand> | undefined, handedOff = false;
  try {
    input.signal.throwIfAborted();
    snapshot = stageConfinement(input);
    launch = confinementCommand({ ...input, root: snapshot.root });
    handedOff = true;
    return await runOwnedProxyChild({ ...input, cwd: snapshot.root, executable: '/bin/bun' }, { spawn, confinedLaunch: launch });
  } finally {
    try { if (!handedOff) await input.scope.close(); }
    finally { launch?.dispose(); snapshot?.dispose(); }
  }
}
