#!/usr/bin/env bun
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../..');
const addonsDir = join(repoRoot, 'addons');

function hasFeatureFile(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && hasFeatureFile(full)) return true;
    if (entry.isFile() && entry.name.endsWith('.feature')) return true;
  }
  return false;
}

const slugs = readdirSync(addonsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((slug) => hasFeatureFile(join(addonsDir, slug, 'tests', 'features')))
  .sort();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(slugs));
} else {
  for (const slug of slugs) console.log(slug);
}
