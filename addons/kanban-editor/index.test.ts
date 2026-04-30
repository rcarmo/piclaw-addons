import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import addon from './index.ts';

const addonDir = import.meta.dir;

test('kanban-editor exports an extension entrypoint', () => {
  expect(typeof addon).toBe('function');
});

test('kanban-editor manifest declares the web pane entry', () => {
  const manifest = JSON.parse(readFileSync(resolve(addonDir, 'package.json'), 'utf8')) as any;
  expect(manifest.name).toBe('@rcarmo/piclaw-addon-kanban-editor');
  expect(manifest.pi?.web?.entries).toEqual(['web/index.ts']);
});

test('kanban-editor README documents wiki links', () => {
  const readme = readFileSync(resolve(addonDir, 'README.md'), 'utf8');
  expect(readme).toContain('[[ops-roadmap]]');
  expect(readme).toContain('opens the target board in a normal workspace tab/editor');
});
