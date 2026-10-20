import { test, expect } from 'bun:test';
import { bindNativeCodexProvider, createNativeCodexProfile } from './src/native-provider.ts';
test('binding is immediate and detects discarded overrides', () => {
  let current: { id: string } | undefined;
  const models = { setProvider(p: { id: string }) { current = p; }, getProvider() { return current; } };
  const binding = bindNativeCodexProvider(models, { id: 'openai-codex' }, async () => {});
  binding.check(); current = undefined;
  expect(() => binding.check()).toThrow('not bound');
});
test('profiles restore tools and operation guards exact owner', () => {
  let tools = ['read', 'web_search'];
  const profile = createNativeCodexProfile({ getActiveTools: () => tools, setActiveTools: next => { tools = next; } });
  const model = { provider: 'openai-codex', id: 'gpt-5', api: 'openai-codex-responses', input: ['text', 'image'] };
  profile.modelSelect(model); expect(tools).toContain('exec_command'); expect(tools).toContain('web_search');
  profile.modelSelect({ provider: 'other', id: 'other', api: 'other' }); expect(tools).toEqual(['read', 'web_search']);
  const controller = new AbortController();
  const scope = profile.operation({ id: 'op', sessionId: 's', cwd: '/unused', model, signal: controller.signal, assertCurrent() {} });
  expect(() => scope.check({ ...model, id: 'wrong' })).toThrow();
  expect(scope.hooks.request({ tools: [{ type: 'function', name: 'web_search' }] })).toMatchObject({ tools: [{ type: 'web_search' }] });
  controller.abort(); expect(() => scope.check()).toThrow();
});
