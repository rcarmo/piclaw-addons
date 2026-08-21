import { describe, expect, test } from 'bun:test';

import { resolveRequestedAddon } from './generate-specs-args';

describe('resolveRequestedAddon', () => {
  test('ignores the Bun executable and script path', () => {
    expect(resolveRequestedAddon([
      '/opt/bun/bin/bun',
      '/repo/tests/addon-e2e/scripts/generate-specs.ts',
      'observability',
    ])).toBe('observability');
  });

  test('uses the first positional script argument', () => {
    expect(resolveRequestedAddon([
      '/opt/bun/bin/bun',
      '/repo/tests/addon-e2e/scripts/generate-specs.ts',
      '--verbose',
      'microsoft-365',
      'observability',
    ])).toBe('microsoft-365');
  });

  test('prefers PICLAW_ADDON', () => {
    expect(resolveRequestedAddon([
      '/opt/bun/bin/bun',
      '/repo/tests/addon-e2e/scripts/generate-specs.ts',
      'observability',
    ], 'microsoft-365')).toBe('microsoft-365');
  });
});
