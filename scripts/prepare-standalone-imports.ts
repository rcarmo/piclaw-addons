#!/usr/bin/env bun
/** Acquire the standalone import graphs in a fresh directory, before timed tests. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..');
export const standaloneSlugs = [
  'autoresearch', 'cheapskate', 'restic', 'code-review', 'codex-conversion', 'delegate', 'drawio-editor',
  'editable-table', 'goal', 'image-processing', 'imap', 'kanban-editor', 'lite-term', 'm365', 'mindmap',
  'observability', 'office-tools', 'office-viewer', 'plan-sidebar', 'portainer', 'proxmox', 'remote-peer',
  'session-dashboard', 'session-tree', 'skill-model-effort', 'smart-compaction', 'vent', 'voice-pipeline',
  'win-ui', 'yolo-vibe', 'linkr',
] as const;
export type StandaloneSlug = typeof standaloneSlugs[number];
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export function standaloneImportPlan(slug: StandaloneSlug) {
  const source = join(repo, 'addons', slug);
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (!Object.keys(manifest.dependencies ?? {}).length) return { source, main: manifest.main || 'index.ts' };
  // Preserve the standalone consumer shape and the exact host pins previously
  // passed to Bun from inside the timed test.
  const pins = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).devDependencies;
  manifest.devDependencies ??= {};
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (typeof pins[name] === 'string') manifest.devDependencies[name] = pins[name];
  }
  const piVersion = pins['@earendil-works/pi-coding-agent'];
  manifest.overrides ??= {};
  for (const name of ['chord', 'pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-codemode', 'pi-mcp', 'pi-tui']) {
    manifest.overrides[`@earendil-works/${name}`] = piVersion;
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const sourceLockPath = join(source, 'bun.lock');
  const sourceLock = existsSync(sourceLockPath) ? readFileSync(sourceLockPath) : null;
  return { source, main: manifest.main || 'index.ts', manifestText, sourceLock,
    input: hash(`${hash(manifestText)}:${sourceLock ? hash(sourceLock) : 'no-source-lock'}`) };
}

export function preparedStandaloneModules(root: string | undefined, slug: StandaloneSlug, input: string): string {
  const bad = () => Error(`Standalone dependencies for ${slug} are missing or stale; run scripts/prepare-standalone-imports.ts in a fresh fixture root first.`);
  if (!root || !existsSync(root)) throw bad();
  const directory = join(realpathSync(root), slug);
  const marker = join(directory, 'ready.json'), lock = join(directory, 'bun.lock'), modules = join(directory, 'node_modules');
  if (!existsSync(marker) || !existsSync(lock) || !existsSync(modules) || !lstatSync(modules).isDirectory()) throw bad();
  const receipt = JSON.parse(readFileSync(marker, 'utf8'));
  if (receipt.input !== input || receipt.lock !== hash(readFileSync(lock))) throw bad();
  return modules;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path || !lstatSync(path).isDirectory() || readdirSync(path).length)
    throw Error('Usage: bun run scripts/prepare-standalone-imports.ts <existing empty directory>');
  const root = realpathSync(path);
  for (const slug of standaloneSlugs) {
    const plan = standaloneImportPlan(slug);
    if (!plan.manifestText) continue;
    const cwd = join(root, slug);
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'package.json'), plan.manifestText);
    if (plan.sourceLock) writeFileSync(join(cwd, 'bun.lock'), plan.sourceLock);
    const installed = Bun.spawnSync([process.execPath, 'install', '--prefer-offline'], {
      cwd, timeout: 30_000,
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? join(root, 'cache') },
      stdout: 'pipe', stderr: 'pipe',
    });
    if (installed.exitCode !== 0) throw Error(`Standalone dependency preparation failed for ${slug} (exit ${installed.exitCode}): ${installed.stderr.toString()}`);
    const lock = hash(readFileSync(join(cwd, 'bun.lock')));
    writeFileSync(join(cwd, 'ready.json'), JSON.stringify({ input: plan.input, lock }));
    console.log(`[standalone-prep] ${slug}: ${lock}`);
  }
}
