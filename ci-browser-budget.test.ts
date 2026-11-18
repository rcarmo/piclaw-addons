import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('Regrets browser qualification allows provisioning time without dropping either browser or its tests', () => {
  const workflow = readFileSync(new URL('./.github/workflows/validate-metadata.yml', import.meta.url), 'utf8');
  const job = workflow.match(/^  late-night-regrets:\n([\s\S]*?)(?=^  [a-z-]+:|$(?![\s\S]))/m)?.[1];
  expect(job).toBeDefined();
  expect(job).toContain('runs-on: ubuntu-24.04');
  expect(job).toContain('timeout-minutes: 20');
  expect(job).toContain('mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe');
  expect(job).toContain('PLAYWRIGHT_BROWSERS_PATH: /ms-playwright');
  expect(job).toContain('apt-get install -y --no-install-recommends unzip');
  expect(job!.indexOf('apt-get install')).toBeLessThan(job!.indexOf('oven-sh/setup-bun@'));
  expect(job).toContain('bunx playwright install chromium webkit');
  expect(job).not.toContain('playwright install --with-deps');
  expect(job).toContain('bun test addons/late-night-regrets');
});
