import { expect, test } from 'bun:test';
import type { AssistantMessage, KnownProvider } from '@earendil-works/pi-ai';
import type { ChildRequestPlanV1 } from './contracts.ts';
import { encodeFrame, FrameDecoder } from './framing.ts';
import { projectEvent } from './validation.ts';

// The provider ID changed in Pi 1.0.3; API identifiers are a separate namespace.
// These synthetic fixtures do not load or call an Azure provider.
const provider = 'azure' satisfies KnownProvider;
const plan: ChildRequestPlanV1 = { version: 1, execution: 'parent-provider-proxy', model: { provider, id: 'deployment' }, mcp: 'none' };
const message = (): AssistantMessage => ({
  role: 'assistant', api: 'azure-openai-responses', provider, model: 'deployment',
  content: [{ type: 'text', text: 'fixture' }], stopReason: 'stop', timestamp: 1,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

test('Pi 1.0.3 azure provider identity survives projection/framing without API renaming', () => {
  for (const api of ['azure-openai-responses', 'openai-completions']) {
    for (const responseModel of ['deployment', 'azure/deployment']) {
      const event = projectEvent({ type: 'done', reason: 'stop', message: { ...message(), api, responseModel } }, plan);
      const received: unknown[] = [];
      const decoder = new FrameDecoder(value => received.push(value));
      decoder.push(encodeFrame(event)); decoder.end();
      expect(received).toEqual([{ type: 'done', reason: 'stop', message: { ...message(), api, responseModel } }]);
    }
  }
});

test('Pi 1.0.3 azure plan does not silently alias legacy or foreign response identity', () => {
  for (const change of [
    { provider: 'azure-openai-responses' },
    { responseModel: 'azure-openai-responses/deployment' },
    { model: 'other-deployment' },
  ]) {
    expect(() => projectEvent({ type: 'done', reason: 'stop', message: { ...message(), ...change } }, plan)).toThrow('REQUEST_FAILED');
  }
});
