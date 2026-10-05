import { expect, test } from 'bun:test';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { validateContext, projectEvent } from './validation.ts';
import type { ChildRequestPlanV1 } from './contracts.ts';
const plan: ChildRequestPlanV1 = { version: 1, execution: 'parent-provider-proxy', model: { provider: 'synthetic', id: 'fixture' }, mcp: 'none' };
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text: 'hello' }], provider: 'synthetic', model: 'fixture', api: 'fixture', usage, stopReason: 'stop', timestamp: 1 });

test('public Context validates every role and separates tool history from request authority', () => {
  const tool = { name: 'read', description: 'Read fixture', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
  const input = { systemPrompt: 'fixture', tools: [tool], messages: [
    { role: 'system', content: 'system', timestamp: 0, sections: { policy: 'text', old: null }, toolsAdded: [tool], toolsRemoved: [{ name: 'old' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }], timestamp: 1 },
    message(),
    { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{ type: 'text', text: 'fixture' }], isError: false, timestamp: 2 },
  ] };
  const result = validateContext(input);
  expect(JSON.stringify(result)).toBe(JSON.stringify(input)); expect(result).not.toBe(input);
  expect(() => validateContext({ messages: [{ ...input.messages[3], details: { env: 'secret' } }] })).toThrow('INVALID_FRAME');
  expect(() => validateContext({ messages: [{ ...input.messages[0], ownerId: 'forged' }] })).toThrow('INVALID_FRAME');
  expect(() => validateContext({ messages: [message()], headers: { Authorization: 'secret' } })).toThrow('INVALID_FRAME');
});

test('context rejects malformed content, role, tool schemas, numbers and diagnostics', () => {
  for (const msg of [
    { role: 'unknown', content: 'bad', timestamp: 0 },
    { role: 'user', content: [{ type: 'image', data: 'AA==', mimeType: 'application/pdf' }], timestamp: 0 },
    { role: 'user', content: [], timestamp: -1 },
    { ...message(), usage: { ...usage, totalTokens: -1 } },
    { ...message(), usage: { ...usage, cost: { ...usage.cost, total: Infinity } } },
    { ...message(), errorMessage: 'PRIVATE' },
    { ...message(), providerDiagnostics: [{ message: 'PRIVATE' }] },
    { ...message(), content: [{ type: 'toolCall', id: 't', name: 'read', arguments: [] }] },
  ]) expect(() => validateContext({ messages: [msg] })).toThrow('INVALID_FRAME');
  expect(() => validateContext({ messages: [], tools: [{ name: 'read', description: 'text', parameters: {}, execute: 'forged' }] })).toThrow('INVALID_FRAME');
});

test('event projection drops errors/diagnostics and rejects model changes or deferred replies', () => {
  const raw = { ...message(), errorMessage: 'PRIVATE', providerDiagnostics: [{ message: 'PRIVATE' }], metadata: { Authorization: 'PRIVATE' } };
  const projected = projectEvent({ type: 'start', partial: raw }, plan);
  expect(projected).toEqual({ type: 'start', partial: message() });
  expect(JSON.stringify(projected)).not.toContain('PRIVATE');
  const failed = projectEvent({ type: 'error', reason: 'error', error: { ...raw, stopReason: 'error' } }, plan);
  expect(JSON.stringify(failed)).not.toContain('PRIVATE');
  for (const change of [{ model: 'other' }, { provider: 'other' }, { responseModel: 'other' }]) {
    expect(() => projectEvent({ type: 'done', reason: 'stop', message: { ...message(), ...change } }, plan)).toThrow('REQUEST_FAILED');
  }
  expect(() => projectEvent({ type: 'done', reason: 'deferred', message: { ...message(), stopReason: 'deferred' } }, plan)).toThrow('REQUEST_FAILED');
  expect(() => projectEvent({ type: 'done', reason: 'stop', message: { ...message(), stopReason: 'toolUse' } }, plan)).toThrow('INVALID_FRAME');
});

test('content events validate indices and mandatory delta/end payloads', () => {
  const partial = message();
  expect(projectEvent({ type: 'text_delta', contentIndex: 0, delta: 'x', partial }, plan)).toMatchObject({ delta: 'x' });
  for (const event of [
    { type: 'text_delta', contentIndex: -1, delta: 'x', partial },
    { type: 'text_delta', contentIndex: 0, partial },
    { type: 'text_end', contentIndex: 0, partial },
    { type: 'toolcall_end', contentIndex: 0, partial },
    { type: 'mystery', contentIndex: 0, partial },
  ]) expect(() => projectEvent(event as AssistantMessageEvent, plan)).toThrow('INVALID_FRAME');
});

test('public system text blocks and constrained sampling are bounded data, never execution fields', () => {
  const tool = { name: 'read', description: 'fixture', parameters: { type: 'object' } };
  for (const constrainedSampling of [false, { type: 'json_schema', strict: 'prefer' }, { type: 'json_schema', strict: 'require' }, { type: 'grammar', variants: { openai_lark: 'start: "ok"', openai_regex: '^ok$' } }]) {
    const context = { messages: [{ role: 'system', content: [{ type: 'text', text: 'fixture' }], timestamp: 0, toolsAdded: [{ ...tool, constrainedSampling }], toolsRemoved: [{ name: 'old' }] }] };
    expect(JSON.stringify(validateContext(context))).toBe(JSON.stringify(context));
  }
  for (const constrainedSampling of [true, { type: 'json_schema', strict: 'maybe' }, { type: 'grammar', variants: {} }, { type: 'grammar', variants: { arbitrary: 'x' } }, { type: 'json_schema', strict: 'prefer', execute: 'bad' }]) {
    expect(() => validateContext({ messages: [], tools: [{ ...tool, constrainedSampling }] })).toThrow('INVALID_FRAME');
  }
});
