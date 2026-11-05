import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = import.meta.dir;

test('A2A package, protocol, runtime, pane and skill are absent', () => {
  expect(existsSync(join(root, 'addons/a2a'))).toBe(false);
});

test('A2A is absent from aggregate registration, catalogue, dependency graph and validation commands', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const catalogue = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'));
  expect(catalogue.addons.some((addon: any) => addon.slug === 'a2a' || addon.name === '@rcarmo/piclaw-addon-a2a')).toBe(false);
  for (const entries of [manifest.pi.extensions, manifest.pi.skills, manifest.pi.runtime.entries])
    expect(entries.some((entry: string) => entry.includes('addons/a2a/'))).toBe(false);
  expect(manifest.agents.skills.some((entry: any) => entry.name === 'a2a' || entry.path.includes('/a2a/'))).toBe(false);
  expect(manifest.devDependencies).not.toHaveProperty('@a2a-js/sdk');
  expect(readFileSync(join(root, 'bun.lock'), 'utf8')).not.toContain('"@a2a-js/sdk"');
  expect(manifest.scripts).not.toHaveProperty('typecheck:a2a');
  for (const command of Object.values(manifest.scripts)) expect(command as string).not.toContain('addons/a2a');
});

test('ordinary Piclaw-to-Piclaw messaging and other runtime entries remain registered', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  expect(manifest.pi.extensions).toContain('addons/remote-peer/index.ts');
  expect(manifest.pi.extensions).toContain('addons/delegate/index.ts');
  expect(manifest.pi.runtime.entries).toContain('addons/remote-peer/runtime.ts');
  expect(manifest.pi.runtime.entries).toContain('addons/autoresearch/runtime.ts');
});
