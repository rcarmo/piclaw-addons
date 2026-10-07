import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface AddonRoutes { codeReview: boolean; regrets: boolean; ux: string[]; broad: boolean }

export function routeAddonChecks(paths: string[] | null, slugs: string[], uxSlugs: string[]): AddonRoutes {
  const all = (): AddonRoutes => ({ codeReview: true, regrets: true, ux: [...uxSlugs].sort(), broad: true });
  if (paths === null) return all();
  const changed = new Set<string>();
  for (const path of paths) {
    // Catalog changes accompany normal version bumps; catalog-only edits stay broad.
    if (path === 'catalog.json') continue;
    const slug = /^addons\/([^/]+)\//.exec(path)?.[1];
    if (!slug || !slugs.includes(slug)) return all();
    changed.add(slug);
  }
  if (paths.includes('catalog.json') && changed.size === 0) return all();
  return { codeReview: changed.has('code-review'), regrets: changed.has('late-night-regrets'),
    ux: uxSlugs.filter(slug => changed.has(slug)).sort(), broad: false };
}

export function changedPaths(root: string, base: string, head: string): string[] | null {
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) return null;
  for (const sha of [base, head]) {
    if (Bun.spawnSync(['git', 'cat-file', '-e', `${sha}^{commit}`], { cwd: root }).exitCode !== 0) return null;
  }
  const mergeBase = Bun.spawnSync(['git', 'merge-base', base, head], { cwd: root, stdout: 'pipe' });
  if (mergeBase.exitCode !== 0) return null;
  // No rename folding: both deleted and added paths must participate in routing.
  const diff = Bun.spawnSync(['git', 'diff', '--no-renames', '--name-only', '-z',
    mergeBase.stdout.toString().trim(), head, '--'], { cwd: root, stdout: 'pipe' });
  return diff.exitCode === 0 ? diff.stdout.toString().split('\0').filter(Boolean) : null;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const slugs = readdirSync(join(root, 'addons'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const uxSlugs = slugs.filter(slug => existsSync(join(root, 'addons', slug, 'tests/features')) &&
    [...new Bun.Glob('**/*.feature').scanSync(join(root, 'addons', slug, 'tests/features'))].length > 0);
  const paths = process.env.EVENT_NAME === 'pull_request'
    ? changedPaths(root, process.env.BASE_SHA ?? '', process.env.HEAD_SHA ?? '') : null;
  const routes = routeAddonChecks(paths, slugs, uxSlugs);
  const output = `code_review=${routes.codeReview}\nregrets=${routes.regrets}\nux=${routes.ux.join(',')}\nbroad=${routes.broad}\n`;
  console.log(output.trim());
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
}
