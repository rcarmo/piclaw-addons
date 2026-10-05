import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { ChildRequestScopeV1 } from './contracts.ts';
import { runOwnedProxyChild } from './owned-child.ts';

test('actual public AgentSession uses child proxy for tool request and continuation with no auth/profile discovery', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'proxy-agent-work-')); writeFileSync(join(cwd, 'fixture.txt'), 'READ_FIXTURE_ONLY');
  let requests = 0, closed = 0; const roles: string[][] = [];
  const scope: ChildRequestScopeV1 = {
    plan: { version: 1, execution: 'parent-provider-proxy', model: { provider: 'synthetic', id: 'fixture' }, mcp: 'none' },
    stream(context) {
      requests++; roles.push(context.messages.map(m => m.role));
      const first = requests === 1;
      if (!first) expect(JSON.stringify(context.messages)).toContain('READ_FIXTURE_ONLY');
      const message: AssistantMessage = { role: 'assistant', provider: 'synthetic', model: 'fixture', api: 'openai-completions', timestamp: requests,
        content: first ? [{ type: 'toolCall', id: 'read_1', name: 'read', arguments: { path: 'fixture.txt' } }] : [{ type: 'text', text: 'agent fixture complete' }],
        stopReason: first ? 'toolUse' : 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { settled: Promise.resolve(), cancel() {}, async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial: { ...message, stopReason: 'pending' } } as AssistantMessageEvent;
        yield { type: 'done', reason: first ? 'toolUse' : 'stop', message } as AssistantMessageEvent;
      } };
    }, async close() { closed++; },
  };
  try {
    const result = await runOwnedProxyChild({ scope, executable: process.execPath, entrypoint: join(import.meta.dir, 'fixture-child.ts'), cwd, args: ['agent'], signal: new AbortController().signal, timeoutMs: 10000 });
    expect(JSON.parse(result.output).responses).toEqual(['agent fixture complete']); expect(requests).toBe(2); expect(closed).toBe(1);
    expect(roles[1]).toContain('toolResult');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 15000);
