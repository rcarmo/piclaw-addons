import { expect, test } from 'bun:test';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { ChildProxySession } from './child-session.ts';
import { ParentProxySession } from './parent-session.ts';
import { encodeFrame, FrameDecoder } from './framing.ts';
import { LIMITS, type ChildRequestPlanV1, type ChildRequestScopeV1 } from './contracts.ts';

const plan: ChildRequestPlanV1 = { version: 1, execution: 'parent-provider-proxy', model: { provider: 'synthetic', id: 'fixture' }, mcp: 'none' };
const message = (text = 'hello'): AssistantMessage => ({ role: 'assistant', api: 'fixture', provider: 'synthetic', model: 'fixture', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 1,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const start = (): AssistantMessageEvent => ({ type: 'start', partial: message() });
const done = (): AssistantMessageEvent => ({ type: 'done', reason: 'stop', message: message() });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve!: () => void, reject!: (e: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const sent: any[] = []; let disconnected = 0;
  const decoder = new FrameDecoder(value => sent.push(value));
  const child = new ChildProxySession({ plan, send: async bytes => decoder.push(bytes), disconnect() { disconnected++; } });
  const receive = (seq: number, event: AssistantMessageEvent) => child.push(encodeFrame({ version: 1, type: 'event', id: 'request_1', seq, event }));
  return { child, sent, receive, disconnects: () => disconnected };
}

test('child validates ID/sequence and requires terminal plus settlement before another request', async () => {
  const f = fixture(), stream = f.child.stream({ messages: [] }); const consumed: AssistantMessageEvent[] = [];
  const consume = (async () => { for await (const e of stream) consumed.push(e); })();
  f.receive(0, start()); f.receive(1, done()); await consume;
  expect(consumed.map(x => x.type)).toEqual(['start', 'done']);
  expect(() => f.child.stream({ messages: [] })).toThrow('INVALID_FRAME');
  let settled = false; void stream.settled.then(() => { settled = true; }); await tick(); expect(settled).toBe(false);
  f.child.push(encodeFrame({ version: 1, type: 'settled', id: 'request_1', seq: 2 })); await stream.settled;
  expect(settled).toBe(true);
  const next = f.child.stream({ messages: [] }, { maxTokens: 5 });
  expect(f.sent.map(x => x.id)).toEqual(['request_1', 'request_2']);
  f.child.close(); await expect(next.settled).rejects.toThrow('CANCELLED');
  expect(f.disconnects()).toBe(1);
});

test('child rejects mismatched IDs, repeated sequences, malformed events and premature settlement', async () => {
  for (const bad of [
    { version: 1, type: 'event', id: 'foreign', seq: 0, event: start() },
    { version: 1, type: 'event', id: 'request_1', seq: 1, event: start() },
    { version: 1, type: 'settled', id: 'request_1', seq: 0 },
    { version: 1, type: 'event', id: 'request_1', seq: 0, event: done() },
    { version: 1, type: 'error', id: 'request_1', seq: 0, code: 'raw secret' },
    { version: 1, type: 'event', id: 'request_1', seq: 0, event: { type: 'start', partial: { ...message(), errorMessage: 'PRIVATE' } } },
  ]) {
    const f = fixture(), stream = f.child.stream({ messages: [] });
    expect(() => f.child.push(encodeFrame(bad))).toThrow('INVALID_FRAME');
    await expect(stream.settled).rejects.toThrow('INVALID_FRAME');
    expect(f.disconnects()).toBe(1);
  }
  const f = fixture(), stream = f.child.stream({ messages: [] }); f.receive(0, start());
  expect(() => f.receive(0, start())).toThrow('INVALID_FRAME');
  await expect(stream.settled).rejects.toThrow();
});

test('cancel is one wire request, rejects iteration immediately, but waits for host settlement', async () => {
  const f = fixture(), stream = f.child.stream({ messages: [] }); stream.cancel(); stream.cancel();
  expect(f.sent.map(x => x.type)).toEqual(['start', 'cancel']);
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('CANCELLED');
  let settled = false; void stream.settled.then(() => { settled = true; }); await tick(); expect(settled).toBe(false);
  f.child.push(encodeFrame({ version: 1, type: 'error', id: 'request_1', seq: 0, code: 'CANCELLED' }));
  f.child.push(encodeFrame({ version: 1, type: 'settled', id: 'request_1', seq: 1 })); await stream.settled;
  expect(settled).toBe(true); f.child.close();
});

test('slow consumers cannot accumulate more than one frame budget and EOF cannot imply settled', async () => {
  const f = fixture(), stream = f.child.stream({ messages: [] });
  const partial = message('x'.repeat(Math.floor(LIMITS.frameBytes / 2)));
  f.receive(0, { type: 'start', partial });
  expect(() => f.receive(1, { type: 'text_delta', contentIndex: 0, delta: 'x', partial })).toThrow('LIMIT');
  await expect(stream.settled).rejects.toThrow('LIMIT');
  const eof = fixture(), pending = eof.child.stream({ messages: [] }); eof.child.end();
  await expect(pending.settled).rejects.toThrow('REQUEST_FAILED'); expect(eof.disconnects()).toBe(1);
});

test('two in-memory private channels preserve stream events and raw-tail lifetime end to end', async () => {
  const tail = deferred(); let parent!: ParentProxySession, child!: ChildProxySession, executions = 0, closeCount = 0;
  const scope: ChildRequestScopeV1 = { plan,
    stream(context, options, request) {
      executions++; expect(context.messages).toEqual([]); expect(options).toEqual({ reasoning: 'high' }); expect(request.requestId).toBe('request_1');
      return { settled: tail.promise, cancel() {}, async *[Symbol.asyncIterator]() { yield start(); yield done(); } };
    },
    async close() { closeCount++; await tail.promise; },
  };
  child = new ChildProxySession({ plan, async send(bytes) { parent.push(bytes); }, disconnect() { void parent.close().catch(() => {}); } });
  parent = new ParentProxySession({ scope, async send(bytes, signal) { signal.throwIfAborted(); child.push(bytes); } });
  const stream = child.stream({ messages: [] }, { reasoning: 'high' }), received = [];
  for await (const event of stream) received.push(event.type);
  expect(received).toEqual(['start', 'done']); expect(executions).toBe(1);
  let finished = false; void stream.settled.then(() => { finished = true; }); await tick(); expect(finished).toBe(false);
  tail.resolve(); await stream.settled; await parent.close(); child.close();
  expect(finished).toBe(true); expect(closeCount).toBe(1);
});
