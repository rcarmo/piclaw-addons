import { describe, expect, test } from 'bun:test';
import { addonFromFile } from './generate-report-paths';

describe('addonFromFile', () => {
  test('resolves generated absolute and Playwright-relative spec paths', () => {
    expect(addonFromFile('/repo/tests/addon-e2e/.generated/drawio-editor/editor.spec.ts')).toBe('drawio-editor');
    expect(addonFromFile('drawio-editor/editor.spec.ts')).toBe('drawio-editor');
  });

  test('uses configured fallback only when the file has no add-on directory', () => {
    expect(addonFromFile('editor.spec.ts', 'drawio-editor')).toBe('drawio-editor');
    expect(addonFromFile('editor.spec.ts', '')).toBe('addon');
  });
});
