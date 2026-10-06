import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = import.meta.dir;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-sync-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'addons/example'), { recursive: true });
  copyFileSync(join(root, 'scripts/sync-catalog.ts'), join(dir, 'scripts/sync-catalog.ts'));
  writeFileSync(join(dir, 'addons/example/index.ts'), 'export default function () {}\n');
  writeFileSync(join(dir, 'addons/example/package.json'), JSON.stringify({
    name: '@rcarmo/piclaw-addon-example', version: '1.0.0', description: 'Example',
    keywords: ['piclaw-addon'], pi: { extensions: ['index.ts'] },
  }));
  writeFileSync(join(dir, 'package.json'), '{}\n');
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ addons: [{ slug: 'example',
    owner: { login: 'owner', url: 'https://example.com/owner' },
    contributors: [{ login: 'contributor', url: 'https://example.com/contributor' }],
  }] }));
  function git(...args: string[]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: dir, env: { ...process.env,
      GIT_AUTHOR_DATE: args.includes('Later change') ? '2026-02-02T12:00:00Z' : '2026-01-01T12:00:00Z',
      GIT_COMMITTER_DATE: args.includes('Later change') ? '2026-02-02T12:00:00Z' : '2026-01-01T12:00:00Z',
    }, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('add', '.');
  git('commit', '-qm', 'Initial');
  function run(mode: string) {
    return Bun.spawnSync([process.execPath, join(dir, 'scripts/sync-catalog.ts'), mode],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  }
  function metadata() {
    return [readFileSync(join(dir, 'catalog.json'), 'utf8'), readFileSync(join(dir, 'package.json'), 'utf8')];
  }
  return { dir, git, run, metadata };
}

test('synced metadata checks without writes; generation is deterministic and preserves attribution', () => {
  const f = fixture();
  try {
    expect(f.run('--write').exitCode).toBe(0);
    const generated = f.metadata();
    expect(f.run('--write').stdout.toString()).toContain('already in sync');
    expect(f.run('--check').exitCode).toBe(0);
    expect(f.metadata()).toEqual(generated);
    const entry = JSON.parse(generated[0]).addons[0];
    expect(entry.owner.login).toBe('owner');
    expect(entry.contributors[0].login).toBe('contributor');
    expect(entry.updatedAt).toBe('2026-01-01');
    expect(entry.install.spec).toBe('https://rcarmo.github.io/piclaw-addons/packages/piclaw-addon-example-1.0.0.tgz');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('stale metadata fails read-only checks until explicitly regenerated', () => {
  const f = fixture();
  try {
    const before = f.metadata();
    expect(f.run('--check').exitCode).toBe(1);
    expect(f.metadata()).toEqual(before);
    expect(f.run('--write').exitCode).toBe(0);
    expect(f.run('--check').exitCode).toBe(0);
    writeFileSync(join(f.dir, 'package.json'), '{}\n');
    const staleRoot = f.metadata();
    expect(f.run('--check').exitCode).toBe(1);
    expect(f.metadata()).toEqual(staleRoot);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('later commits keep the generated version date; a new version refreshes it', () => {
  const f = fixture();
  try {
    expect(f.run('--write').exitCode).toBe(0);
    const before = f.metadata();
    // Simulate metadata generated before the PR commit lands on a later date.
    writeFileSync(join(f.dir, 'addons/example/index.ts'), 'export default function () { return 1; }\n');
    f.git('add', '.');
    f.git('commit', '-qm', 'Later change', '--date=2026-02-02T12:00:00Z');
    expect(f.run('--check').exitCode).toBe(0);
    expect(f.metadata()).toEqual(before);
    const path = join(f.dir, 'addons/example/package.json');
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    pkg.version = '1.0.1';
    writeFileSync(path, JSON.stringify(pkg));
    expect(f.run('--check').exitCode).toBe(1);
    expect(f.run('--write').exitCode).toBe(0);
    const entry = JSON.parse(f.metadata()[0]).addons[0];
    expect(entry.updatedAt).toBe('2026-02-02');
    expect(entry.version).toBe('1.0.1');
    expect(entry.owner.login).toBe('owner');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('automatic sync is read-only; only explicit dispatch can regenerate or push', () => {
  const source = readFileSync(join(root, '.github/workflows/sync-catalog.yml'), 'utf8');
  expect(source).toContain('permissions:\n  contents: read');
  const check = source.slice(source.indexOf('  check:'), source.indexOf('  repair:'));
  const repair = source.slice(source.indexOf('  repair:'));
  expect(check).toContain("if: github.event_name != 'workflow_dispatch'");
  expect(check).toContain('contents: read');
  expect(check).toContain('run: bun run check:catalog');
  expect(check).not.toContain('git push');
  expect(check).not.toContain('run: bun run sync:catalog');
  expect(repair).toContain("if: github.event_name == 'workflow_dispatch'");
  expect(repair).toContain('contents: write');
  expect(repair).toContain('run: bun run sync:catalog');
  expect(repair).toContain('git push');
  expect(source).not.toContain('contents: ${{');
  const validation = readFileSync(join(root, '.github/workflows/validate-metadata.yml'), 'utf8');
  expect(validation).toContain('run: bun run check:catalog');
  expect(validation).toContain('run: bun test sync-catalog.test.ts');
});
