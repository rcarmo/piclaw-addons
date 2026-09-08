import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ensureTestFilesystemIsolation, assertPathWithinTestFilesystemIsolation, assertNoTestMounts } from './scripts/lib/test-filesystem-isolation.js';
import { requireDisposableTestTarget } from './scripts/lib/test-target.js';

test('addon test bootstrap replaces live paths and strips injected service credentials', () => {
  const env = { ...process.env, PICLAW_TEST_FS_ISOLATION_ACTIVE: '0', PICLAW_WORKSPACE: '/workspace', HOME: '/home/agent', PORTAINER_RELAY: 'not-real', GITHUB_PICLAW_BOT_PAT: 'not-real' };
  const root = ensureTestFilesystemIsolation(env);
  try {
    expect(env.PICLAW_WORKSPACE).toStartWith(root.root + '/');
    expect(env.HOME).toStartWith(root.root + '/');
    expect(env.PORTAINER_RELAY).toBeUndefined(); expect(env.GITHUB_PICLAW_BOT_PAT).toBeUndefined();
    expect(() => assertPathWithinTestFilesystemIsolation('/workspace/notes', env)).toThrow();
    expect(() => assertNoTestMounts(root.root, `1 0 0:0 / ${root.root}/mount rw - overlay overlay rw`)).toThrow();
  } finally { root.cleanup(); }
});

test('browser target cannot default to a live instance', () => {
  expect(() => requireDisposableTestTarget(undefined, {})).toThrow();
  expect(() => requireDisposableTestTarget('http://localhost:8080', {})).toThrow();
  expect(requireDisposableTestTarget('http://127.0.0.1:3000', { PICLAW_E2E_DISPOSABLE: '1' })).toBe('http://127.0.0.1:3000');
});

test('CI launches the workspace returned by preparation and uses test-only auth', () => {
  const workflow = readFileSync(new URL('./.github/workflows/build.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('done <<< "$prepared"');
  expect(workflow).toContain('PICLAW_E2E_DISPOSABLE:');
  expect(workflow).toContain('PICLAW_E2E_INTERNAL_SECRET:');
  expect(workflow).not.toContain('export PICLAW_WORKSPACE=$(mktemp -d)');
});

test('CI browser cache survives isolated HOME and workflow PRs cannot deploy', () => {
  const workflow = readFileSync(new URL('./.github/workflows/build.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('echo "PLAYWRIGHT_BROWSERS_PATH=$RUNNER_TEMP/piclaw-addon-playwright" >> "$GITHUB_ENV"');
  expect(workflow.indexOf('PLAYWRIGHT_BROWSERS_PATH=')).toBeLessThan(workflow.indexOf('- name: Install Playwright browser'));
  expect(workflow).toContain("  pull_request:\n    paths:\n      - '.github/workflows/build.yml'");
  for (const step of ['Build site and package tarballs', 'Copy assets into docs', 'Deploy to GitHub Pages']) {
    expect(workflow).toContain(`- name: ${step}\n        if: always() && github.event_name != 'pull_request'`);
  }
});
