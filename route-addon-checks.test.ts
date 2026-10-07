import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedPaths, routeAddonChecks } from './scripts/route-addon-checks';

const slugs = ['delegate', 'code-review', 'late-night-regrets', 'remote-peer'];
const ux = ['delegate', 'remote-peer'];

test('single-addon changes preserve only their browser coverage', () => {
  for (const slug of slugs) {
    const result = routeAddonChecks([`addons/${slug}/index.ts`, 'catalog.json'], slugs, ux);
    expect(result.codeReview).toBe(slug === 'code-review');
    expect(result.regrets).toBe(slug === 'late-night-regrets');
    expect(result.ux).toEqual(ux.includes(slug) ? [slug] : []);
    expect(result.broad).toBe(false);
  }
});

test('shared, unknown and unverified changes fall back to every suite', () => {
  for (const paths of [null, ['scripts/build.ts'], ['BUN_VERSION'], ['bun.lock'], ['catalog.json'],
    ['tests/addon-e2e/steps/shared.ts'], ['addons/unknown/index.ts']]) {
    expect(routeAddonChecks(paths, slugs, ux)).toEqual({ codeReview: true, regrets: true, ux, broad: true });
  }
  expect(routeAddonChecks([], slugs, ux).ux).toEqual([]);
  expect(routeAddonChecks(['addons/delegate/deleted.ts', 'addons/code-review/renamed.ts'], slugs, ux))
    .toEqual({ codeReview: true, regrets: false, ux: ['delegate'], broad: false });
});

test('Git routing verifies commit identities and includes both sides of cross-addon renames', () => {
  const root = mkdtempSync(join(tmpdir(), 'addon-route-'));
  function git(...args: string[]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    mkdirSync(join(root, 'addons/delegate'), { recursive: true });
    mkdirSync(join(root, 'addons/code-review'), { recursive: true });
    writeFileSync(join(root, 'addons/delegate/index.ts'), 'original');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    git('mv', 'addons/delegate/index.ts', 'addons/code-review/index.ts');
    git('commit', '-qm', 'rename');
    const head = git('rev-parse', 'HEAD');
    expect(changedPaths(root, base, head)).toEqual(['addons/code-review/index.ts', 'addons/delegate/index.ts']);
    expect(changedPaths(root, 'unknown-fork-base', head)).toBeNull();
    expect(changedPaths(root, '0'.repeat(40), head)).toBeNull();
    expect(changedPaths(root, base, 'HEAD')).toBeNull();
    // No remote identity assumptions: a verified fork commit uses the same local graph.
    expect(routeAddonChecks(changedPaths(root, base, head), slugs, ux).codeReview).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workflow routes browser jobs but keeps metadata required and publication broad', () => {
  const read = (name: string): any => Bun.YAML.parse(readFileSync(join(import.meta.dir, '.github/workflows', name), 'utf8'));
  const validation = read('validate-metadata.yml');
  expect(validation.jobs.validate.if).toBeUndefined();
  expect(validation.jobs.routes.steps[0].with['fetch-depth']).toBe(0);
  const route = validation.jobs.routes.steps.find((s: any) => s.id === 'route');
  expect(route.env.BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}');
  expect(route.env.HEAD_SHA).toBe('${{ github.event.pull_request.head.sha }}');
  expect(validation.on.workflow_call.outputs.ux.value).toBe('${{ jobs.routes.outputs.ux }}');
  const build = read('build.yml');
  const steps = build.jobs.build.steps;
  expect(steps.find((s: any) => s.id === 'addon_tests').env.SELECTED_ADDONS).toBe('${{ needs.validation.outputs.ux }}');
  expect(steps.find((s: any) => s.id === 'ux').env.PICLAW_ADDON).toBe('${{ needs.validation.outputs.ux }}');
  expect(steps.find((s: any) => s.name === 'Checkout Piclaw runtime for add-on UX tests').with.ref)
    .toBe('e4c2b9a3536eb64361da86237a4dfc970d772682');
});
