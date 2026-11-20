import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparedStandaloneModules, standaloneImportPlan, standaloneSlugs, type StandaloneSlug } from './scripts/prepare-standalone-imports.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixtureDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function importStandaloneAddon(slug: StandaloneSlug) {
  const plan = standaloneImportPlan(slug);
  const modules = plan.input ? preparedStandaloneModules(process.env.PICLAW_STANDALONE_FIXTURES, slug, plan.input) : null;
  const tempRoot = fixtureDir(`piclaw-addon-${slug}-`);
  const packageDir = join(tempRoot, `piclaw-addon-${slug}`);
  cpSync(plan.source, packageDir, { recursive: true, filter: source => basename(source) !== 'node_modules' });
  expect(existsSync(join(packageDir, 'node_modules'))).toBe(false);
  if (modules) symlinkSync(modules, join(packageDir, 'node_modules'), 'dir');
  else symlinkSync(join(import.meta.dir, 'node_modules'), join(tempRoot, 'node_modules'), 'dir');
  return import(pathToFileURL(join(packageDir, plan.main)).href);
}

const timeouts: Partial<Record<StandaloneSlug, number>> = {
  restic: 30_000, 'code-review': 120_000, 'codex-conversion': 300_000, 'image-processing': 120_000,
  observability: 120_000, 'office-tools': 120_000, 'remote-peer': 120_000,
};
for (const slug of standaloneSlugs) {
  const title = slug === 'linkr' ? 'linkr addon imports outside the monorepo' :
    `standalone piclaw-addon-${slug} imports outside the monorepo root`;
  test(title, async () => {
    const mod = await importStandaloneAddon(slug);
    if (slug === 'restic') return; // Its former case also tested import only.
    expect(typeof mod.default).toBe('function');
    if (slug === 'session-dashboard') expect(typeof mod.queryRecentSessions).toBe('function');
    if (slug === 'linkr') expect(mod.skillNames.length).toBe(7);
    if (slug !== 'office-tools') return;

    const workspace = fixtureDir('piclaw-office-tools-roundtrip-');
    const markdown = '# Inventory\n\n| Item | Count |\n| --- | ---: |\n| Widget | 3 |';
    const xlsxWrite = await mod.executeOfficeWrite({ path: 'inventory.xlsx', markdown }, undefined, { cwd: workspace });
    expect(xlsxWrite.details).toMatchObject({ ok: true, format: '.xlsx' });
    const xlsxRead = await mod.executeOfficeRead({ path: 'inventory.xlsx' }, { cwd: workspace });
    expect(xlsxRead.details).toMatchObject({ ok: true, format: '.xlsx' });
    expect(xlsxRead.content[0]?.text).toContain('Widget');

    const docxWrite = await mod.executeOfficeWrite({ path: 'inventory.docx', markdown }, undefined, { cwd: workspace });
    expect(docxWrite.details).toMatchObject({ ok: true, format: '.docx' });
    const docxRead = await mod.executeOfficeRead({ path: 'inventory.docx' }, { cwd: workspace });
    expect(docxRead.details).toMatchObject({ ok: true, format: '.docx' });
    expect(docxRead.content[0]?.text).toContain('Inventory');
  }, timeouts[slug]);
}

test('standalone dependencies fail closed when preparation is absent or stale', () => {
  const root = fixtureDir('standalone-prep-negative-');
  const slug = 'codex-conversion';
  const input = standaloneImportPlan(slug).input!;
  expect(() => preparedStandaloneModules(undefined, slug, input)).toThrow('missing or stale');
  expect(() => preparedStandaloneModules(root, slug, input)).toThrow('missing or stale');
  const dir = join(root, slug);
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'bun.lock'), 'synthetic changed lock');
  writeFileSync(join(dir, 'ready.json'), JSON.stringify({ input, lock: 'not-the-lock-hash' }));
  expect(() => preparedStandaloneModules(root, slug, input)).toThrow('missing or stale');
});
