import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ChildRequestScopeV1 } from './contracts.ts';
import { childEnvironment, runOwnedProxyChild } from './owned-child.ts';

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(hold = false) {
  const tail = gate(), entered = gate(); if (!hold) tail.resolve();
  let requests = 0, closes = 0, cancels = 0;
  const scope: ChildRequestScopeV1 = {
    plan: { version: 1, execution: 'parent-provider-proxy', model: { provider: 'synthetic', id: 'fixture' }, mcp: 'none' },
    stream(_context, options) {
      requests++; expect(options).toEqual({ maxTokens: 10 }); entered.resolve();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'offline fixture' }], api: 'openai-completions', provider: 'synthetic', model: 'fixture', stopReason: 'stop', timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { settled: tail.promise, cancel() { cancels++; }, async *[Symbol.asyncIterator]() {
        yield { type: 'start' as const, partial: { ...message, stopReason: 'pending' as const } };
        yield { type: 'done' as const, reason: 'stop' as const, message };
      } };
    },
    async close() { closes++; await tail.promise; },
  };
  return { scope, tail, entered, counts: () => ({ requests, closes, cancels }) };
}
function run(f: ReturnType<typeof fixture>, mode: string, signal = new AbortController().signal, timeoutMs = 5000) {
  return runOwnedProxyChild({ scope: f.scope, executable: process.execPath, entrypoint: join(import.meta.dir, 'fixture-child.ts'), cwd: import.meta.dir, args: [mode], signal, timeoutMs });
}

test('minimal environment omits inherited secrets and runtime injection controls', () => {
  const env = childEnvironment('/isolated');
  expect(Object.keys(env).sort()).toEqual(['HOME','OTEL_SDK_DISABLED','PATH','PI_CODING_AGENT_DIR','PI_OFFLINE','PI_TELEMETRY','TMPDIR','XDG_CACHE_HOME','XDG_CONFIG_HOME','XDG_DATA_HOME'].sort());
  expect(env.PI_CODING_AGENT_DIR).toBe('/isolated/agent');
});

test('actual Bun child uses private pipes/public SDK twice and deletes only its profile after host close', async () => {
  const f = fixture(); process.env.DELEGATE_TEST_PARENT_SECRET = 'SYNTHETIC_NEVER_IN_CHILD';
  try {
    const result = await run(f, 'twice');
    const receipt = JSON.parse(result.output);
    expect(result.exitCode).toBe(0); expect(receipt.responses).toEqual(['stop', 'stop']); expect(receipt.envSafe).toBe(true);
    expect(existsSync(receipt.profile)).toBe(false); expect(existsSync(receipt.home)).toBe(false);
    expect(result.output).not.toContain('SYNTHETIC_NEVER_IN_CHILD'); expect(f.counts()).toEqual({ requests: 2, closes: 1, cancels: 0 });
  } finally { delete process.env.DELEGATE_TEST_PARENT_SECRET; }
});

test('child abort kills process but cannot complete before the held raw host tail', async () => {
  const f = fixture(true), aborter = new AbortController();
  let finished = false;
  const task = run(f, 'stubborn', aborter.signal).finally(() => { finished = true; }); void task.catch(() => {});
  await f.entered.promise; aborter.abort(); await Bun.sleep(150);
  expect(finished).toBe(false); expect(f.counts().cancels).toBeGreaterThan(0);
  f.tail.resolve(); await expect(task).rejects.toThrow('CANCELLED'); expect(f.counts().closes).toBe(1);
});

test('child crash and deadline retain host settlement ownership', async () => {
  for (const mode of ['crash', 'deadline']) {
    const f = fixture(true); let finished = false;
    const task = run(f, mode, new AbortController().signal, mode === 'deadline' ? 300 : 5000).finally(() => { finished = true; }); void task.catch(() => {});
    await f.entered.promise; await Bun.sleep(mode === 'deadline' ? 450 : 120);
    expect(finished).toBe(false); f.tail.resolve();
    await expect(task).rejects.toThrow(mode === 'deadline' ? 'CANCELLED' : 'REQUEST_FAILED'); expect(f.counts().closes).toBe(1);
  }
});

test.each(['grandchild', 'inherited-grandchild'])('successful leader exit kills owned %s even when it retains stdio', async mode => {
  const f = fixture(); const result = await run(f, mode); const pid = JSON.parse(result.output).grandchild;
  expect(Number.isInteger(pid)).toBe(true);
  let alive = true;
  for (let i = 0; i < 50; i++) {
    try { alive = !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); }
    catch { alive = false; }
    if (!alive) break; await Bun.sleep(10);
  }
  expect(alive).toBe(false); expect(f.counts().closes).toBe(1);
});

test('pre-abort, unsupported plan, missing executable and truncated EOF all close the host once', async () => {
  for (const mode of ['pre-abort', 'plan', 'missing', 'truncated']) {
    const f = fixture();
    if (mode === 'plan') (f.scope.plan as any).mcp = 'required';
    const task = mode === 'missing'
      ? runOwnedProxyChild({ scope: f.scope, executable: '/nonexistent/delegate-bun', entrypoint: join(import.meta.dir, 'fixture-child.ts'), cwd: import.meta.dir, signal: new AbortController().signal, timeoutMs: 500 })
      : run(f, mode, mode === 'pre-abort' ? AbortSignal.abort() : new AbortController().signal);
    await expect(task).rejects.toThrow(); expect(f.counts().closes).toBe(1); expect(f.counts().requests).toBe(0);
  }
});
