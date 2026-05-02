#!/usr/bin/env bun
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const repoRoot = resolve(import.meta.dir, '../../..');
const addonsDir = join(repoRoot, 'addons');
const runtimeRoot = resolve(process.env.PICLAW_RUNTIME_ROOT || join(repoRoot, '..', 'piclaw'));
const workspace = process.env.PICLAW_WORKSPACE || mkdtempSync(join(tmpdir(), 'piclaw-addon-e2e-'));
const selectedArg = process.argv.includes('--addon') ? process.argv[process.argv.indexOf('--addon') + 1] : '';
const selected = process.env.PICLAW_ADDON || selectedArg || 'all';

function walkHasFeature(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && walkHasFeature(full)) return true;
    if (entry.isFile() && entry.name.endsWith('.feature')) return true;
  }
  return false;
}

function addonSlugs(): string[] {
  if (selected !== 'all') return selected.split(',').map((s) => s.trim()).filter(Boolean);
  return readdirSync(addonsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) => walkHasFeature(join(addonsDir, slug, 'tests', 'features')))
    .sort();
}

function packageDirForName(nodeModulesDir: string, packageName: string): string {
  return join(nodeModulesDir, ...packageName.split('/'));
}

function findPeerNodeModules(): string | null {
  const candidates = [
    join(runtimeRoot, 'node_modules'),
    join(runtimeRoot, '..', 'node_modules'),
    join(repoRoot, 'node_modules'),
    '/usr/local/lib/bun/install/global/node_modules',
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

mkdirSync(join(workspace, '.piclaw'), { recursive: true });
if (!existsSync(join(workspace, '.piclaw', 'config.json'))) {
  writeFileSync(join(workspace, '.piclaw', 'config.json'), JSON.stringify({ sessionAutoRotate: true }, null, 2));
}

const extensionsDir = join(workspace, '.pi', 'extensions');
const nodeModulesDir = join(extensionsDir, 'node_modules');
mkdirSync(nodeModulesDir, { recursive: true });

const pkgPath = join(extensionsDir, 'package.json');
const localPkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : { name: 'piclaw-addon-e2e-local-addons', private: true, dependencies: {} };
localPkg.private = true;
localPkg.dependencies ||= {};

const peerNodeModules = findPeerNodeModules();
const installed: string[] = [];
for (const slug of addonSlugs()) {
  const addonRoot = join(addonsDir, slug);
  const addonPkg = JSON.parse(readFileSync(join(addonRoot, 'package.json'), 'utf8'));
  const dest = packageDirForName(nodeModulesDir, addonPkg.name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(addonRoot, dest, {
    recursive: true,
    filter: (src) => !src.includes('/node_modules/') && !src.includes('/tests/reports/'),
  });
  if (peerNodeModules) {
    const link = join(dest, 'node_modules');
    try {
      if (existsSync(link) || lstatSync(link)) rmSync(link, { recursive: true, force: true });
    } catch {}
    try { symlinkSync(peerNodeModules, link, 'dir'); } catch {}
  }
  localPkg.dependencies[addonPkg.name] = `file:${dest}`;
  installed.push(`${slug} (${addonPkg.name}@${addonPkg.version})`);
}
writeFileSync(pkgPath, JSON.stringify(localPkg, null, 2));

console.log(`PICLAW_WORKSPACE=${workspace}`);
console.log(`Prepared ${installed.length} add-on(s): ${installed.join(', ') || '(none)'}`);
