import { expect, test } from 'bun:test';
import type { SimpleStreamOptions } from '@earendil-works/pi-ai';
import { requestFrame } from './framing.ts';
import type { ChildRequestOptionsV1, ClientFrame } from './contracts.ts';

// Pi 1.0.2 adds model-level samplingParamsByThinkingLevel. Neither model
// metadata nor the existing arbitrary samplingParams belongs on the child wire.
test('Pi 1.0.2 sampling metadata does not widen the child request allowlist', () => {
  const options = { temperature: 0.5, maxTokens: 32, reasoning: 'high' } satisfies ChildRequestOptionsV1;
  const publicOptions: SimpleStreamOptions = options;
  const start = { version: 1, type: 'start', id: 'sampling', context: { messages: [] }, options: publicOptions } satisfies ClientFrame;
  expect(requestFrame(start)).toEqual(start);
  for (const field of ['samplingParams', 'samplingParamsByThinkingLevel']) {
    const value = { high: { temperature: 0.9 }, top_p: 0.5 };
    expect(() => requestFrame({ ...start, [field]: value })).toThrow('INVALID_FRAME');
    expect(() => requestFrame({ ...start, options: { ...options, [field]: value } })).toThrow('INVALID_FRAME');
    expect(() => requestFrame({ ...start, context: { messages: [], [field]: value } })).toThrow('INVALID_FRAME');
  }
});
