import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ParentProxySession } from './parent-session.ts';
import { createPipeChannel } from './pipe.ts';
import { ProxyError, type ChildRequestScopeV1 } from './contracts.ts';

/** Explicit Bun launch environment; no profiles, provider credentials, NODE_OPTIONS,
 * preload hooks, inherited telemetry or arbitrary parent env. This is not a filesystem
 * or network sandbox: callers must separately restrict built-in tool access. */
export function childEnvironment(root: string): Record<string, string> {
  return { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root,
    XDG_CACHE_HOME: root, XDG_DATA_HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'),
    PI_OFFLINE: '1', PI_TELEMETRY: '0', OTEL_SDK_DISABLED: 'true' };
}

/** Owns one trusted Bun child and host scope. No global runtime registration.
 * Scope close and OS close are separate required acknowledgements; never timeout
 * the host close promise. The trusted entrypoint/args must be credential-free. */
export async function runOwnedProxyChild(input: {
  scope: ChildRequestScopeV1;
  executable: string;
  entrypoint: string;
  cwd: string;
  args?: string[];
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<{ exitCode: number | null; output: string }> {
  if (process.platform !== 'linux' || !isAbsolute(input.executable) || !isAbsolute(input.entrypoint)
    || !isAbsolute(input.cwd) || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 300000) {
    await input.scope.close(); throw new ProxyError('UNSUPPORTED_PLAN');
  }
  if (input.signal.aborted) { await input.scope.close(); throw new ProxyError('CANCELLED'); }
  let root: string | undefined;
  let parent: ParentProxySession | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), 'delegate-proxy-'));
    chmodSync(root, 0o700); mkdirSync(join(root, 'agent'), { mode: 0o700 });
    let channel: ReturnType<typeof createPipeChannel> | undefined;
    // Validate scope before starting any OS child.
    parent = new ParentProxySession({ scope: input.scope, send: (bytes, signal) => {
      if (!channel) return Promise.reject(new ProxyError('REQUEST_FAILED'));
      return channel.send(bytes, signal);
    } });
    const child = spawn(input.executable, ['--no-env-file', input.entrypoint, ...(input.args ?? [])], {
      cwd: input.cwd, env: childEnvironment(root), detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    let failed = false, output = '', outputBytes = 0;
    const exited = new Promise<number | null>(resolve => {
      child.once('error', () => { failed = true; });
      child.once('close', code => resolve(code));
    });
    // Some runtimes omit all stdio objects when process creation fails.
    if (!child.stdout || !child.stderr || !child.stdio[3] || !child.stdio[4]) {
      await exited; throw new ProxyError('REQUEST_FAILED');
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let channelEnd: Promise<void> | undefined;
    function kill(signal: NodeJS.Signals) {
      if (child.pid) {
        try { process.kill(-child.pid, signal); }
        catch { try { child.kill(signal); } catch { /* OS close is still required */ } }
      }
    }
    const stop = () => {
      if (failed) return;
      failed = true;
      void parent?.close().catch(() => {});
      kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 100);
    };
    channel = createPipeChannel(child.stdio[4] as Readable, child.stdio[3] as Writable, {
      data(bytes) { parent!.push(bytes); },
      lost(error) {
        if (error) stop();
        channelEnd = parent!.end().catch(() => { failed = true; });
      },
    });
    const deadline = setTimeout(stop, input.timeoutMs);
    input.signal.addEventListener('abort', stop, { once: true });
    if (input.signal.aborted) stop();
    child.stdout!.on('data', (bytes: Buffer) => {
      outputBytes += bytes.length;
      if (outputBytes > 64000) stop(); else output += bytes.toString('utf8');
    });
    // Never reflect arbitrary child diagnostics. Bound and discard stderr.
    child.stderr!.on('data', (bytes: Buffer) => { outputBytes += bytes.length; if (outputBytes > 64000) stop(); });
    // Descendants can retain stdio fds, so kill on leader exit before waiting for close.
    child.once('exit', () => kill('SIGKILL'));
    try {
      const exitCode = await exited;
      // Kill descendants still in the owned process group even after a successful leader exit.
      kill('SIGKILL'); channel.close();
      clearTimeout(deadline); if (killTimer) clearTimeout(killTimer);
      input.signal.removeEventListener('abort', stop);
      await parent.close(); await channelEnd;
      if (failed || input.signal.aborted) throw new ProxyError('CANCELLED');
      if (exitCode !== 0) throw new ProxyError('REQUEST_FAILED');
      return { exitCode, output };
    } finally {
      clearTimeout(deadline); if (killTimer) clearTimeout(killTimer);
      input.signal.removeEventListener('abort', stop);
      kill('SIGKILL'); channel.close(); await exited;
    }
  } finally {
    try { await (parent ? parent.close() : input.scope.close()); }
    finally { if (root) rmSync(root, { recursive: true, force: true }); }
  }
}
