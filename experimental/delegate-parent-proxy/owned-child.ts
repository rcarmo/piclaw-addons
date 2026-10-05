import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ParentProxySession } from './parent-session.ts';
import { createPipeChannel } from './pipe.ts';
import { ProxyError, type ChildRequestScopeV1 } from './contracts.ts';

/** Explicit environment; this does not restrict filesystem/network access by tools. */
export function childEnvironment(root: string): Record<string, string> {
  return { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root,
    XDG_CACHE_HOME: root, XDG_DATA_HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'),
    PI_OFFLINE: '1', PI_TELEMETRY: '0', OTEL_SDK_DISABLED: 'true' };
}

/** Owns one trusted Bun child and host scope. OS close and host raw settlement are
 * independent acknowledgements; neither is replaced by a timer. The trusted
 * entrypoint/args must be credential-free. No runtime registration occurs here. */
export async function runOwnedProxyChild(input: {
  scope: ChildRequestScopeV1;
  executable: string;
  entrypoint: string;
  cwd: string;
  args?: string[];
  signal: AbortSignal;
  timeoutMs: number;
}, dependencies: { spawn: typeof spawn } = { spawn }): Promise<{ exitCode: number | null; output: string }> {
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
    parent = new ParentProxySession({ scope: input.scope, send: (bytes, signal) => {
      if (!channel) return Promise.reject(new ProxyError('REQUEST_FAILED'));
      return channel.send(bytes, signal);
    } });
    const child = dependencies.spawn(input.executable, ['--no-env-file', input.entrypoint, ...(input.args ?? [])], {
      cwd: input.cwd, env: childEnvironment(root), detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    let failed = false, stopStarted = false, osClosed = false, output = '', outputBytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    let channelEnd: Promise<void> | undefined;
    function kill(signal: NodeJS.Signals) {
      if (child.pid) { try { process.kill(-child.pid, signal); return; } catch { /* direct-child fallback */ } }
      try { child.kill(signal); } catch { /* OS close still required */ }
    }
    function stop() {
      failed = true;
      if (stopStarted || osClosed) return;
      stopStarted = true;
      void parent!.close().catch(() => {});
      kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 100);
    }
    const exited = new Promise<number | null>(resolve => {
      child.on('error', stop);
      child.once('exit', () => kill('SIGKILL')); // descendants may retain stdio
      child.once('close', code => { osClosed = true; resolve(code); });
    });
    // Everything after spawn is covered, including synchronous pipe/setup failures.
    try {
      if (!child.stdout || !child.stderr || !child.stdio[3] || !child.stdio[4]) throw new ProxyError('REQUEST_FAILED');
      channel = createPipeChannel(child.stdio[4] as Readable, child.stdio[3] as Writable, {
        data(bytes) { parent!.push(bytes); },
        lost(error) {
          if (error) stop();
          channelEnd = parent!.end().catch(() => { failed = true; });
        },
      });
      deadline = setTimeout(stop, input.timeoutMs);
      input.signal.addEventListener('abort', stop, { once: true });
      if (input.signal.aborted) stop();
      child.stdout.on('data', (bytes: Buffer) => {
        outputBytes += bytes.length;
        if (outputBytes > 64000) stop(); else output += bytes.toString('utf8');
      });
      child.stderr.on('data', (bytes: Buffer) => { outputBytes += bytes.length; if (outputBytes > 64000) stop(); });
      const exitCode = await exited;
      kill('SIGKILL'); channel.close();
      clearTimeout(deadline); if (killTimer) clearTimeout(killTimer);
      input.signal.removeEventListener('abort', stop);
      await parent.close(); await channelEnd;
      if (failed || input.signal.aborted) throw new ProxyError('CANCELLED');
      if (exitCode !== 0) throw new ProxyError('REQUEST_FAILED');
      return { exitCode, output };
    } finally {
      clearTimeout(deadline);
      input.signal.removeEventListener('abort', stop);
      if (!osClosed) stop();
      kill('SIGKILL'); channel?.close(); await exited;
      if (killTimer) clearTimeout(killTimer);
    }
  } finally {
    try { await (parent ? parent.close() : input.scope.close()); }
    finally { if (root) rmSync(root, { recursive: true, force: true }); }
  }
}
