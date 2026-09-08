import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
const root = resolve(import.meta.dir, '..');
const preload = join(root, 'scripts/test-preload.ts');
const dirs = new Set<string>([root]);
function walk(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.tmp', '.generated', '.piclaw-runtime', 'docs', 'reports', 'test-results', 'vendor'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) dirs.add(dirname(p));
  }
}
walk(root);
for (const dir of dirs) {
  const expected = `[test]\npreload = ["${relative(dir, preload).replaceAll('\\', '/').replace(/^(?!\.)/, './')}"]\n`;
  if (!existsSync(join(dir, 'bunfig.toml')) || readFileSync(join(dir, 'bunfig.toml'), 'utf8').replace(/\r\n/g, '\n') !== expected) throw new Error(`Missing test preload in ${relative(root, dir) || '.'}`);
}
console.log(`Test preload coverage: ${dirs.size} directories`);
