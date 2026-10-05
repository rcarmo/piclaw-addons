import { expect, test } from 'bun:test';
import type { Context, AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { ChildRequestScopeV1, ChildRequestStreamV1 } from './contracts.ts';
import { ProxyError } from './contracts.ts';
import { FrameDecoder, encodeFrame } from './framing.ts';
import { ParentProxySession } from './parent-session.ts';

const deferred = () => { let resolve!: () => void, reject!: (e: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const message = { role: 'assistant', content: [{ type: 'text', text: 'fixture' }], api: 'fixture', provider: 'synthetic', model: 'fixture', stopReason: 'stop', timestamp: 1,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
const events: AssistantMessageEvent[] = [{ type: 'start', partial: message }, { type: 'done', reason: 'stop', message }];
const frame = (id: string) => encodeFrame({ version: 1, type: 'start', id, context: { messages: [] }, options: {} });
function fixture(sequence = events, settlement = deferred(), writeGate?: Promise<void>) {
  let calls = 0, cancels = 0, closes = 0, produced = 0;
  const output: any[] = [];
  const scope: ChildRequestScopeV1 = {
    plan: { version: 1, execution: 'parent-provider-proxy', model: { provider: 'synthetic', id: 'fixture' }, mcp: 'none' },
    stream(): ChildRequestStreamV1 { calls++; return {
      settled: settlement.promise,
      cancel() { cancels++; },
      async *[Symbol.asyncIterator]() { for (const event of sequence) { produced++; yield event; } },
    }; },
    async close() { closes++; await settlement.promise; },
  };
  const decoder = new FrameDecoder(value => output.push(value));
  const session = new ParentProxySession({ scope, validateContext: (value) => value as Context, publicEvent: event => event,
    async send(bytes, signal) { if (writeGate) await writeGate; if (signal.aborted) throw new ProxyError('CANCELLED'); decoder.push(bytes); },
  });
  return { session, scope, output, settlement, counts: () => ({ calls, cancels, closes, produced }) };
}

test('one terminal event precedes settled; next request cannot begin while raw tail is pending', async () => {
  const f = fixture(); f.session.push(frame('r1')); await tick();
  expect(f.output.map(x => x.type)).toEqual(['event', 'event']);
  expect(f.output.map(x => x.seq)).toEqual([0, 1]);
  expect(() => f.session.push(frame('r2'))).toThrow('INVALID_FRAME');
  let closed = false; const closing = f.session.close().then(() => { closed = true; });
  await tick(); expect(closed).toBe(false);
  f.settlement.resolve(); await closing;
  expect(f.counts().calls).toBe(1); expect(f.counts().closes).toBe(1);
  expect(f.output.some(x => x.type === 'settled')).toBe(false);
});

test('success releases request only after settlement and rejects duplicate IDs', async () => {
  const f = fixture(); f.session.push(frame('r1')); await tick();
  f.settlement.resolve(); await tick();
  expect(f.output.map(x => x.type)).toEqual(['event', 'event', 'settled']);
  expect(f.output.map(x => x.seq)).toEqual([0, 1, 2]);
  expect(() => f.session.push(frame('r1'))).toThrow('INVALID_FRAME');
  await f.session.close(); expect(f.counts().calls).toBe(1);
});

test('backpressure stops provider iteration while a single output frame is pending', async () => {
  const gate = deferred(), f = fixture(events, deferred(), gate.promise);
  f.session.push(frame('slow')); await tick();
  expect(f.counts().produced).toBe(1); expect(f.output).toEqual([]);
  gate.resolve(); f.settlement.resolve(); await tick();
  expect(f.output.map(x => x.type)).toEqual(['event', 'event', 'settled']);
  await f.session.close();
});

test('cancel suppresses further events and waits for raw tail/accounting settlement', async () => {
  const gate = deferred(), f = fixture(events, deferred(), gate.promise);
  f.session.push(frame('cancel')); await tick();
  f.session.push(encodeFrame({ version: 1, type: 'cancel', id: 'cancel' }));
  expect(f.counts().cancels).toBe(1);
  gate.resolve(); await tick();
  expect(f.output.at(-1)).toMatchObject({ type: 'error', code: 'CANCELLED' });
  expect(f.output.some(x => x.type === 'settled')).toBe(false);
  f.settlement.resolve(); await tick(); await f.session.close();
});

test('setup exceptions and provider errors never reflect raw diagnostic text', async () => {
  const f = fixture([{ type: 'error', reason: 'error', error: { ...message, stopReason: 'error', errorMessage: 'PRIVATE_SECRET' } }]);
  f.settlement.resolve(); f.session.push(frame('error')); await tick();
  expect(f.output[0]).toMatchObject({ type: 'error', code: 'REQUEST_FAILED' });
  expect(JSON.stringify(f.output)).not.toContain('PRIVATE_SECRET'); await f.session.close();
  const setup = fixture(); setup.scope.stream = () => { throw Error('PRIVATE_SECRET'); };
  setup.settlement.resolve(); setup.session.push(frame('setup')); await tick();
  expect(setup.output[0]).toMatchObject({ type: 'error', code: 'REQUEST_FAILED' });
  expect(JSON.stringify(setup.output)).not.toContain('PRIVATE_SECRET'); await setup.session.close();
});

test('settlement rejection stops admission without fake success or silent close', async () => {
  const f = fixture(); f.session.push(frame('tail')); await tick();
  f.settlement.reject(Error('PRIVATE_TAIL')); await tick();
  expect(f.output.some(x => x.type === 'settled')).toBe(false);
  expect(() => f.session.push(frame('next'))).toThrow('INVALID_FRAME');
  await expect(f.session.close()).rejects.toThrow('SETTLEMENT_FAILED');
});

test('malformed frames, wrong IDs, invalid event order and EOF fail closed', async () => {
  const f = fixture(); f.settlement.resolve();
  expect(() => f.session.push(encodeFrame({ version: 1, type: 'cancel', id: 'unknown' }))).toThrow('INVALID_FRAME');
  await f.session.close(); expect(f.counts().calls).toBe(0);
  const bad = fixture([{ type: 'done', reason: 'stop', message }]); bad.settlement.resolve(); bad.session.push(frame('order')); await tick();
  expect(bad.output[0]).toMatchObject({ type: 'error', code: 'INVALID_FRAME' }); await bad.session.close();
  const truncated = fixture(); truncated.settlement.resolve(); truncated.session.push(frame('eof').subarray(0, 6));
  await expect(truncated.session.end()).rejects.toThrow('INVALID_FRAME'); expect(truncated.counts().calls).toBe(0);
});

test('close publishes one promise before synchronous cancellation reenters it', async () => {
  let parent!: ParentProxySession, closes = 0, nested: Promise<void> | undefined;
  const tail = deferred();
  const scope: ChildRequestScopeV1 = { plan: { version: 1, execution: 'parent-provider-proxy', model: { provider: 'synthetic', id: 'fixture' }, mcp: 'none' }, stream() { return { settled: tail.promise,
    cancel() { nested = parent.close(); }, async *[Symbol.asyncIterator]() { yield* events; } }; },
    async close() { closes++; await tail.promise; } };
  parent = new ParentProxySession({ scope, async send() {} });
  parent.push(frame('reentry')); await tick();
  const close = parent.close(); await tick();
  expect(nested).toBe(close); expect(closes).toBe(1); tail.resolve(); await close;
});

test('next request can arrive synchronously during settled ACK delivery', async () => {
  let parent!: ParentProxySession, calls = 0;
  const finished = deferred();
  const scope: ChildRequestScopeV1 = { plan: { version: 1, execution: 'parent-provider-proxy', model: { provider: 'synthetic', id: 'fixture' }, mcp: 'none' },
    stream() { calls++; return { settled: Promise.resolve(), cancel() {}, async *[Symbol.asyncIterator]() { yield* events; } }; }, async close() {} };
  const decoder = new FrameDecoder(value => {
    if ((value as any).type === 'settled') {
      if ((value as any).id === 'one') parent.push(frame('two'));
      else finished.resolve();
    }
  });
  parent = new ParentProxySession({ scope, async send(bytes) { decoder.push(bytes); } });
  parent.push(frame('one')); await finished.promise; expect(calls).toBe(2); await parent.close();
});
