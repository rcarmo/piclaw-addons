import { expect, test } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

test('SDK discovery registers declarations only; durable bindings are the sole execution/config/prompt owner', async () => {
  const global = globalThis as typeof globalThis & { __piclaw_registerAddonConfigApi?: (...args: unknown[]) => unknown; __piclawRuntimeInterop?: unknown };
  const previousRegistrar = global.__piclaw_registerAddonConfigApi, previousInterop = global.__piclawRuntimeInterop;
  let configRegistrations = 0, legacyInputs = 0, modelAccess = 0;
  global.__piclaw_registerAddonConfigApi = () => { configRegistrations++; };
  global.__piclawRuntimeInterop = { getModelRegistry() { modelAccess++; throw Error('Ambient model registry forbidden'); } };
  try {
    const modulePath = './index.ts?native-registration';
    const { default: addon }: typeof import('./index.js') = await import(modulePath);
    const events: string[] = [];
    let tool: Parameters<ExtensionAPI['registerTool']>[0] | undefined;
    let command: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
    addon({ on(name: string) { events.push(name); }, registerTool(value: unknown) { tool = value as NonNullable<typeof tool>; },
      registerCommand(_name: string, value: Parameters<ExtensionAPI['registerCommand']>[1]) { command = value; }, sendUserMessage() { legacyInputs++; },
    } as unknown as ExtensionAPI);
    expect(configRegistrations).toBe(0);
    expect(events).toEqual(['resources_discover']);
    expect(tool?.name).toBe('regrets_review'); expect(command).toBeDefined();
    await expect(tool!.execute('unbound', {}, undefined, undefined, {} as never)).rejects.toThrow('native durable');
    await expect(command!.handler('', {} as never)).rejects.toThrow('native durable');
    expect([legacyInputs, modelAccess]).toEqual([0, 0]);
  } finally {
    global.__piclaw_registerAddonConfigApi = previousRegistrar;
    global.__piclawRuntimeInterop = previousInterop;
  }
});

test('native-only package imports outside the repository with only declared peers', async () => {
  const { cpSync, mkdtempSync, rmSync, symlinkSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const parent = mkdtempSync(join(process.env.PICLAW_WORKSPACE!, 'regrets-standalone-'));
  const pkg = join(parent, 'package');
  try {
    cpSync(import.meta.dir, pkg, { recursive: true, filter: path => !path.split('/').includes('node_modules') });
    symlinkSync(join(import.meta.dir, '../../node_modules'), join(pkg, 'node_modules'));
    const module = await import(pathToFileURL(join(pkg, 'index.ts')).href);
    expect(Object.keys(module)).toEqual(['default']);
    const native = await import(pathToFileURL(join(pkg, 'native.ts')).href);
    expect(typeof native.createLateNightRegrets).toBe('function');
    expect(native.regretsToolDeclaration.name).toBe('regrets_review');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
