import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventory, crossRepositoryDuplicates } from './scripts/vendor-inventory';

test('tracked vendor/font/WASM payloads are deterministic and changed bytes invalidate checksums', () => {
  const root = mkdtempSync(join(tmpdir(), 'addon-vendor-'));
  const paths = ['addons/a/web/vendor/a.js', 'addons/b/tool.wasm', 'addons/a/web/font.woff2', 'addons/a/profile.json'];
  try {
    for (const path of paths) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), 'payload'); }
    const before = inventory(root, paths);
    expect(before.files).toHaveLength(3);
    expect(before.duplicatePayloads).toHaveLength(1);
    expect(inventory(root, [...paths].reverse())).toEqual(before);
    const core = { files: [{ path: 'core/vendor/file', sha256: before.files[0].sha256 }] };
    expect(crossRepositoryDuplicates(before, core)).toHaveLength(3);
    writeFileSync(join(root, paths[0]), 'changed');
    expect(inventory(root, paths).files.find(file => file.path === paths[0])?.sha256)
      .not.toBe(before.files.find(file => file.path === paths[0])?.sha256);
    expect(crossRepositoryDuplicates(inventory(root, paths), core)).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
