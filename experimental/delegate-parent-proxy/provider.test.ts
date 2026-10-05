import { expect, test } from 'bun:test';
import { createAssistantMessageEventStream, createModels, normalizeContext, type AssistantMessage, type AssistantMessageEvent, type Model } from '@earendil-works/pi-ai';
import { ChildProxySession } from './child-session.ts';
import { ParentProxySession } from './parent-session.ts';
import { childAgentOptions, createProxyProvider, projectProviderContext } from './provider.ts';
import type { ChildRequestPlanV1, ChildRequestScopeV1 } from './contracts.ts';

const plan: ChildRequestPlanV1 = { version: 1, execution: 'parent-provider-proxy', model: { provider: 'synthetic', id: 'model' }, mcp: 'none' };
const model: Model<any> = { provider: 'synthetic', id: 'model', api: 'openai-completions', name: 'Synthetic', baseUrl: 'https://delegate.invalid', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const message = (): AssistantMessage => ({ role: 'assistant', provider: 'synthetic', model: 'model', api: model.api, timestamp: 1, stopReason: 'stop', content: [{ type: 'text', text: 'synthetic answer' }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise<void>(yes => setTimeout(yes, 0));
function fixture() {
  const tail = deferred(), entered = deferred(); let closed = 0, cancelled = 0, calls = 0;
  let parent!: ParentProxySession, child!: ChildProxySession;
  const scope: ChildRequestScopeV1 = { plan, stream(context, options) {
    calls++; expect(context.messages.at(-1)?.role).toBe('user'); expect(options).toEqual({ maxTokens: 8 }); entered.resolve();
    return { settled: tail.promise, cancel() { cancelled++; }, async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: { ...message(), stopReason: 'pending' } } as AssistantMessageEvent;
      yield { type: 'done', reason: 'stop', message: message() } as AssistantMessageEvent;
    } };
  }, async close() { closed++; await tail.promise; } };
  child = new ChildProxySession({ plan, async send(bytes) { parent.push(bytes); }, disconnect() { void parent.close().catch(() => {}); } });
  parent = new ParentProxySession({ scope, async send(bytes, signal) { signal.throwIfAborted(); child.push(bytes); } });
  const proxy = createProxyProvider({ session: child, plan, model, createStream: createAssistantMessageEventStream });
  const context = normalizeContext({ messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] });
  return { proxy, parent, child, tail, entered, context, counts: () => ({ calls, closed, cancelled }) };
}

test('public Models collection uses credential-free proxy and waits raw ACK before terminal/result', async () => {
  const f = fixture(), models = createModels(); models.setProvider(f.proxy.provider);
  try {
    const stream = models.streamSimple(model, { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }, { maxTokens: 8, maxRetries: 0 });
    const events: string[] = []; const consuming = (async () => { for await (const event of stream) events.push(event.type); })();
    let result = false; void stream.result().then(() => { result = true; });
    await f.entered.promise; await tick();
    expect(events).toEqual(['start']); expect(result).toBe(false);
    expect(() => f.proxy.provider.streamSimple(model, f.context, { maxTokens: 8 })).toThrow('UNSUPPORTED_PLAN');
    f.tail.resolve(); await consuming;
    expect((await stream.result()).content).toEqual(message().content); expect(events).toEqual(['start', 'done']);
    expect(f.counts().calls).toBe(1);
  } finally { f.tail.resolve(); await f.proxy.close(); await f.parent.close(); }
  expect(f.counts().closed).toBe(1);
});

test('abort closes child delivery but parent close stays pending until raw host tail drains', async () => {
  const f = fixture(), aborter = new AbortController();
  const stream = f.proxy.provider.streamSimple(model, f.context, { maxTokens: 8, signal: aborter.signal });
  await f.entered.promise; aborter.abort();
  const result = await stream.result(); expect(result.stopReason).toBe('aborted'); expect(result.errorMessage).toBe('Delegate cancelled');
  let parentClosed = false; const closing = f.parent.close().then(() => { parentClosed = true; });
  await tick(); expect(parentClosed).toBe(false); expect(f.counts().cancelled).toBeGreaterThan(0);
  f.tail.resolve(); await closing; await f.proxy.close(); expect(parentClosed).toBe(true);
});

test('provider rejects authority, unsupported retry semantics, foreign model, pre-abort and secret metadata before dispatch', async () => {
  const f = fixture();
  try {
    for (const options of [{ apiKey: 'SECRET' }, { headers: { Authorization: 'SECRET' } }, { env: { SECRET: 'SECRET' } }, { fetch: () => {} }, { deferred: true }, { samplingParams: {} }, { maxRetries: 1 }, { toolChoice: 'required' }, { cacheRetention: 'long' }, { sessionId: 'ignored' }, { timeoutMs: 0 }]) {
      expect(() => f.proxy.provider.streamSimple(model, f.context, options as any)).toThrow('UNSUPPORTED_PLAN');
    }
    expect(() => f.proxy.provider.streamSimple({ ...model, id: 'foreign' }, f.context)).toThrow('UNSUPPORTED_PLAN');
    expect(() => f.proxy.provider.streamSimple(model, f.context, { signal: AbortSignal.abort() })).toThrow();
    expect(() => createProxyProvider({ session: f.child, plan, model: { ...model, headers: { Authorization: 'SECRET' } }, createStream: createAssistantMessageEventStream })).toThrow('UNSUPPORTED_PLAN');
    expect(f.counts().calls).toBe(0);
  } finally { f.tail.resolve(); await f.proxy.close(); await f.parent.close(); }
});

test('provider timeout stops delivery without releasing held host settlement', async () => {
  const f = fixture(); const stream = f.proxy.provider.streamSimple(model, f.context, { maxTokens: 8, timeoutMs: 10 });
  expect((await stream.result()).stopReason).toBe('aborted');
  let closed = false; const closing = f.parent.close().then(() => { closed = true; });
  await tick(); expect(closed).toBe(false); f.tail.resolve(); await closing; await f.proxy.close();
});

test('trusted child agent option projection never transmits injected authority or callbacks', () => {
  expect(childAgentOptions({ maxTokens: 10, headers: {}, onPayload() {}, sessionId: 'local' })).toEqual({ maxTokens: 10, maxRetries: 0 });
  for (const options of [{ apiKey: 'SECRET' }, { headers: { Authorization: 'SECRET' } }, { env: { SECRET: 'secret' } }, { samplingParams: {} }, { fetch: () => {} }, { deferred: true }, { thinkingBudgets: { high: 100 } }]) {
    expect(() => childAgentOptions(options as any)).toThrow('UNSUPPORTED_PLAN');
  }
});

test('context projection removes local tool-result details/charges and assistant diagnostics', () => {
  const context = normalizeContext({ messages: [
    { ...message(), errorMessage: 'SECRET', providerDiagnostics: [{ message: 'SECRET' }] } as AssistantMessage,
    { role: 'toolResult', toolCallId: 't', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 2, details: { private: 'SECRET' } },
  ] });
  const projected = projectProviderContext(context);
  expect(JSON.stringify(projected)).not.toContain('SECRET'); expect(projected.messages).toHaveLength(2);
  expect(JSON.stringify(context)).toContain('SECRET');
  for (const extra of [{ diagnostics: [{ message: 'PRIVATE' }] }, { deferred: { id: 'unsupported' } }]) {
    const unsupported = normalizeContext({ messages: [{ ...message(), ...extra }] });
    expect(() => projectProviderContext(unsupported)).toThrow('INVALID_FRAME');
  }
});
