/** Vendor the self-contained display contract; never import Core at runtime. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const template = readFileSync(join(root, 'lib/compat/tool-call-summary.ts'), 'utf8');
const catalogue = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')) as { addons: { slug: string }[] };
const write = process.argv.includes('--write');
let count = 0;
for (const { slug } of catalogue.addons) {
  const directory = join(root, 'addons', slug);
  if (!existsSync(join(directory, 'summary.ts'))) continue;
  const file = join(directory, 'compat/tool-call-summary.ts');
  if (!existsSync(file) || readFileSync(file, 'utf8') !== template) {
    if (!write) throw Error(`Tool summary helper is stale: ${slug}`);
    mkdirSync(join(directory, 'compat'), { recursive: true });
    writeFileSync(file, template);
  }
  count++;
}
console.log(`Checked ${count} standalone tool summary helpers.`);
