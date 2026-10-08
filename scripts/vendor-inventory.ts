#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function inventory(root: string, paths: string[]) {
  const files = paths.filter(path => /^addons\//.test(path) &&
    (/(?:^|\/)vendor\//.test(path) || /\.(wasm|woff2?|ttf|otf)$/.test(path))).sort().map(path => {
    const content = readFileSync(join(root, path));
    return { path, addon: path.split('/')[1], bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex') };
  });
  const groups = new Map<string, string[]>();
  for (const file of files) { const group = groups.get(file.sha256) ?? []; group.push(file.path); groups.set(file.sha256, group); }
  return { schemaVersion: 1, scope: 'tracked add-on vendor directories, fonts and WASM; provenance unverified',
    files, duplicatePayloads: [...groups.values()].filter(group => group.length > 1) };
}

export function crossRepositoryDuplicates(addons: ReturnType<typeof inventory>, core: { files: { path: string; sha256: string }[] }) {
  return addons.files.map(file => ({ addonPath: file.path, sha256: file.sha256,
    corePaths: core.files.filter(candidate => candidate.sha256 === file.sha256).map(candidate => candidate.path).sort() }))
    .filter(file => file.corePaths.length > 0);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const proc = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root, stdout: 'pipe' });
  if (proc.exitCode) throw Error('Cannot list tracked vendor files');
  const result = inventory(root, proc.stdout.toString().split('\0').filter(Boolean));
  const text = `${JSON.stringify(result, null, 2)}\n`;
  const path = join(root, 'vendor-inventory.json');
  if (process.argv[2] === '--write') writeFileSync(path, text);
  else if (process.argv[2] === '--check') {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) throw Error('Vendor inventory stale; run bun scripts/vendor-inventory.ts --write');
    console.log('Add-on vendor inventory checksums match.');
  } else if (process.argv[2] === '--compare-core') {
    const core = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    console.log(JSON.stringify(crossRepositoryDuplicates(result, core), null, 2));
  } else console.log(text.trimEnd());
}
