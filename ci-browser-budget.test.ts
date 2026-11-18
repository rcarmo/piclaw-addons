import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('Regrets browser qualification allows provisioning time without dropping either browser or its tests', () => {
  const workflow = readFileSync(new URL('./.github/workflows/validate-metadata.yml', import.meta.url), 'utf8');
  const job = workflow.match(/^  late-night-regrets:\n([\s\S]*?)(?=^  [a-z-]+:|$(?![\s\S]))/m)?.[1];
  expect(job).toBeDefined();
  expect(job).toContain('runs-on: ubuntu-24.04');
  expect(job).toContain('timeout-minutes: 20');
  expect(job).toContain('bunx playwright install --with-deps chromium webkit');
  expect(job).toContain('bun test addons/late-night-regrets');
});
