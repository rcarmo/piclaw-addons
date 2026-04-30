import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(import.meta.dir, 'account-store.ts'), 'utf8');

test('account store uses process-level piclaw keychain access instead of captured extension ctx', () => {
  expect(SOURCE).toContain('async function runPiclaw');
  expect(SOURCE).toContain('Bun.spawn(["piclaw", ...args]');
  expect(SOURCE).not.toContain('pi.exec(');
  expect(SOURCE).not.toContain('ExtensionAPI');
});
