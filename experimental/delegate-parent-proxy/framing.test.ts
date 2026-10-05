import { expect, test } from 'bun:test';
import { LIMITS } from './contracts.ts';
import { encodeFrame, FrameDecoder, requestFrame } from './framing.ts';

const start = { version: 1 as const, type: 'start' as const, id: 'r1', context: { messages: [] }, options: {} };
const packet = (body: Uint8Array) => { const b = Buffer.alloc(body.length + 4); b.writeUInt32BE(body.length); b.set(body, 4); return b; };

test('incremental UTF-8 framing handles every byte split and multiple coalesced frames', () => {
  const input = { ...start, context: { systemPrompt: 'Olá 世界', messages: [] } };
  const bytes = encodeFrame(input), received: unknown[] = [];
  const decoder = new FrameDecoder(value => received.push(requestFrame(value)));
  for (const byte of bytes) decoder.push(Uint8Array.of(byte));
  decoder.push(Buffer.concat([encodeFrame({ version: 1, type: 'cancel', id: 'r1' }), encodeFrame(start)]));
  decoder.end();
  expect(received).toEqual([input, { version: 1, type: 'cancel', id: 'r1' }, start]);
  expect(() => decoder.push(bytes)).toThrow('INVALID_FRAME');
});

test('size, depth, UTF-8, prototype keys and truncated frames fail without reflecting input', () => {
  for (const body of [Uint8Array.of(0xc3, 0x28), Buffer.from('{"secret":"DO_NOT_ECHO"'), Buffer.from('{"__proto__":{}}')]) {
    const decoder = new FrameDecoder(() => { throw Error('must not dispatch'); });
    expect(() => decoder.push(packet(body))).toThrow('INVALID_FRAME');
    expect(() => decoder.push(encodeFrame(start))).toThrow('INVALID_FRAME');
  }
  for (const size of [0, LIMITS.frameBytes + 1]) {
    const header = Buffer.alloc(4); header.writeUInt32BE(size);
    expect(() => new FrameDecoder(() => {}).push(header)).toThrow('LIMIT');
  }
  const decoder = new FrameDecoder(() => {}); decoder.push(encodeFrame(start).subarray(0, 8));
  expect(() => decoder.end()).toThrow('INVALID_FRAME');
  let nested: unknown = {}; for (let i = 0; i < 34; i++) nested = { nested };
  expect(() => encodeFrame(nested)).toThrow('LIMIT');
  expect(() => encodeFrame({ n: Infinity })).toThrow('INVALID_FRAME');
  expect(() => encodeFrame({ text: 'x'.repeat(LIMITS.frameBytes) })).toThrow('LIMIT');
});

test('request/options allowlists exclude child-authored authority and secret channels', () => {
  expect(requestFrame(start)).toEqual(start);
  for (const key of ['model', 'provider', 'account', 'workId', 'headers', 'env', 'apiKey', 'maxCostUsd']) {
    expect(() => requestFrame({ ...start, [key]: 'forged' })).toThrow('INVALID_FRAME');
    expect(() => requestFrame({ ...start, options: { [key]: 'forged' } })).toThrow('INVALID_FRAME');
  }
  expect(() => requestFrame({ ...start, id: '../bad' })).toThrow('INVALID_FRAME');
  expect(() => requestFrame({ ...start, version: 2 })).toThrow('INVALID_FRAME');
  expect(() => requestFrame({ version: 1, type: 'cancel', id: 'r1', context: {} })).toThrow('INVALID_FRAME');
  expect(() => requestFrame({ ...start, context: { messages: [], ownerId: 'forged' } })).toThrow('INVALID_FRAME');
  for (const options of [{ temperature: 3 }, { maxTokens: 0 }, { maxTokens: 1.5 }, { reasoning: 'off' }, { deferred: true }]) {
    expect(() => requestFrame({ ...start, options })).toThrow('INVALID_FRAME');
  }
  for (const reasoning of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    expect(requestFrame({ ...start, options: { temperature: 0, maxTokens: 10, reasoning } })).toMatchObject({ options: { reasoning } });
  }
});
