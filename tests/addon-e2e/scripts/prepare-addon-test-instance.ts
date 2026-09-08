#!/usr/bin/env bun
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const CANONICAL_TMP = '/tmp';

export type Env = Record<string, string | undefined>;

export interface IsolationPaths {
  root: string;
  workspace: string;
  home: string;
  store: string;
  data: string;
  profile: string;
  xdgConfig: string;
  xdgCache: string;
  xdgData: string;
  tmp: string;
}

export interface InstalledAddon {
  slug: string;
  packageName: string;
  version: string;
  destination: string;
}

export interface PrepareOptions {
  env?: Env;
  argv?: string[];
  repoRoot?: string;
  runtimeRoot?: string;
}

export interface PrepareResult {
  paths: IsolationPaths;
  installed: InstalledAddon[];
  packageJsonPath: string;
}

const defaultRepoRoot = resolve(import.meta.dir, '../../..');

export function pathIsInside(parent: string, child: string): boolean {
  const fromParent = relative(resolve(parent), resolve(child));
  return fromParent === '' || (!!fromParent && !fromParent.startsWith('..') && !isAbsolute(fromParent));
}

export function assertNoSymlinkAncestors(target: string, boundary: string, includeTarget = false): void {
  const resolvedBoundary = resolve(boundary);
  const resolvedTarget = resolve(target);
  if (!pathIsInside(resolvedBoundary, resolvedTarget)) {
    throw new Error(`Refusing path outside boundary: ${resolvedTarget}`);
  }

  const parts = relative(resolvedBoundary, resolvedTarget).split(sep).filter(Boolean);
  const pathsToCheck = includeTarget ? parts : parts.slice(0, -1);
  let current = resolvedBoundary;
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
    throw new Error(`Refusing symlink ancestor: ${current}`);
  }
  for (const part of pathsToCheck) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink ancestor: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
  }
}

export function createIsolationPaths(): IsolationPaths {
  const prepRoot = mkdtempSync(join(CANONICAL_TMP, 'piclaw-addon-e2e-'));
  if (!prepRoot || !pathIsInside(CANONICAL_TMP, prepRoot)) {
    throw new Error(`Failed to create isolated preparation root under ${CANONICAL_TMP}`);
  }
  const paths: IsolationPaths = {
    root: prepRoot,
    workspace: join(prepRoot, 'workspace'),
    home: join(prepRoot, 'home'),
    store: join(prepRoot, 'store'),
    data: join(prepRoot, 'data'),
    profile: join(prepRoot, 'profile'),
    xdgConfig: join(prepRoot, 'home', '.config'),
    xdgCache: join(prepRoot, 'home', '.cache'),
    xdgData: join(prepRoot, 'home', '.local', 'share'),
    tmp: join(prepRoot, 'tmp'),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  writeFileSync(join(prepRoot, '.piclaw-addon-e2e-owner'), 'piclaw disposable addon fixture\n', { flag: 'wx' });
  return paths;
}

export function selectedAddonFrom(argv: string[], env: Env = process.env): string {
  const addonFlag = argv.indexOf('--addon');
  const selectedArg = addonFlag >= 0 ? argv[addonFlag + 1] || '' : '';
  return env.PICLAW_ADDON || selectedArg || 'all';
}

export function walkHasFeature(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && walkHasFeature(full)) return true;
    if (entry.isFile() && entry.name.endsWith('.feature')) return true;
  }
  return false;
}

export function validateAddonSlug(addonsDir: string, slug: string): string {
  if (!slug || slug.includes(',') || slug.includes('/') || slug.includes('\\') || slug === '.' || slug === '..') {
    throw new Error(`Refusing invalid add-on slug: ${slug || '(empty)'}`);
  }
  const entry = readdirSync(addonsDir, { withFileTypes: true }).find((candidate) => candidate.name === slug);
  if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Requested add-on slug is not an existing direct add-ons child: ${slug}`);
  }
  const addonRoot = resolve(addonsDir, slug);
  if (dirname(addonRoot) !== resolve(addonsDir)) {
    throw new Error(`Requested add-on slug escapes add-ons directory: ${slug}`);
  }
  return slug;
}

export function addonSlugs(addonsDir: string, selected: string): string[] {
  if (selected !== 'all') return selected.split(',').map((slug) => validateAddonSlug(addonsDir, slug.trim()));
  return readdirSync(addonsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((slug) => walkHasFeature(join(addonsDir, slug, 'tests', 'features')))
    .sort();
}

function validatePackagePart(part: string, label: string): void {
  if (!part || part === '.' || part === '..' || part.includes('\\') || part.includes('/')) {
    throw new Error(`Refusing invalid package ${label}: ${part || '(empty)'}`);
  }
}

export function packageDirForName(nodeModulesDir: string, packageName: string): string {
  const trimmed = packageName.trim();
  const parts = trimmed.split('/');
  if (trimmed.startsWith('@')) {
    if (parts.length !== 2 || !parts[0].startsWith('@')) {
      throw new Error(`Refusing invalid scoped package name: ${packageName}`);
    }
    validatePackagePart(parts[0].slice(1), 'scope');
    validatePackagePart(parts[1], 'name');
  } else {
    if (parts.length !== 1) throw new Error(`Refusing invalid package name: ${packageName}`);
    validatePackagePart(parts[0], 'name');
  }

  const base = resolve(nodeModulesDir);
  const dest = resolve(base, ...parts);
  if (dest === base || !pathIsInside(base, dest)) {
    throw new Error(`Refusing package destination outside node_modules: ${packageName}`);
  }
  return dest;
}

export function findPeerNodeModules(runtimeRoot: string, repoRoot: string): string | null {
  const candidates = [
    join(runtimeRoot, 'node_modules'),
    join(runtimeRoot, '..', 'node_modules'),
    join(repoRoot, 'node_modules'),
  ];
  return candidates.find((candidate) => existsSync(candidate) && lstatSync(candidate).isDirectory() && !lstatSync(candidate).isSymbolicLink()) || null;
}

function shouldCopyAddonPath(addonRoot: string, src: string): boolean {
  if (lstatSync(src).isSymbolicLink()) return false;
  const rel = relative(addonRoot, src).replaceAll('\\', '/');
  if (!rel) return true;
  const parts = rel.split('/');
  if (parts.includes('node_modules')) return false;
  if (parts[0] === 'tests' && parts[1] === 'reports') return false;
  return true;
}

export function prepareAddonTestInstance(options: PrepareOptions = {}): PrepareResult {
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const repoRoot = resolve(options.repoRoot || defaultRepoRoot);
  const addonsDir = join(repoRoot, 'addons');
  const runtimeRoot = resolve(options.runtimeRoot || env.PICLAW_RUNTIME_ROOT || join(repoRoot, '..', 'piclaw'));
  const paths = createIsolationPaths();
  const workspace = paths.workspace;

  mkdirSync(join(workspace, '.piclaw'), { recursive: true });
  writeFileSync(join(workspace, '.piclaw', 'config.json'), JSON.stringify({ sessionAutoRotate: true }, null, 2));

  const extensionsDir = join(workspace, '.pi', 'extensions');
  const nodeModulesDir = join(extensionsDir, 'node_modules');
  mkdirSync(nodeModulesDir, { recursive: true });
  assertNoSymlinkAncestors(nodeModulesDir, workspace, true);

  const pkgPath = join(extensionsDir, 'package.json');
  const localPkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : { name: 'piclaw-addon-e2e-local-addons', private: true, dependencies: {} };
  localPkg.private = true;
  localPkg.dependencies ||= {};

  const peerNodeModules = findPeerNodeModules(runtimeRoot, repoRoot);
  const copiedPeers = peerNodeModules ? join(paths.root, 'dependencies') : null;
  if (peerNodeModules && copiedPeers) {
    // Never symlink test tooling to the host's writable dependency tree.
    cpSync(peerNodeModules, copiedPeers, { recursive: true, dereference: false, filter: (src) => !lstatSync(src).isSymbolicLink() });
  }
  const installed: InstalledAddon[] = [];
  for (const slug of addonSlugs(addonsDir, selectedAddonFrom(argv, env))) {
    const addonRoot = join(addonsDir, slug);
    const addonPkg = JSON.parse(readFileSync(join(addonRoot, 'package.json'), 'utf8'));
    const dest = packageDirForName(nodeModulesDir, addonPkg.name);
    assertNoSymlinkAncestors(dest, nodeModulesDir, true);
    mkdirSync(dirname(dest), { recursive: true });
    assertNoSymlinkAncestors(dirname(dest), nodeModulesDir, true);
    rmSync(dest, { recursive: true, force: true });
    cpSync(addonRoot, dest, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (src) => shouldCopyAddonPath(addonRoot, src),
    });
    if (copiedPeers) {
      const link = join(dest, 'node_modules');
      assertNoSymlinkAncestors(link, dest, true);
      rmSync(link, { recursive: true, force: true });
      symlinkSync(copiedPeers, link, 'dir');
    }
    localPkg.dependencies[addonPkg.name] = `file:${dest}`;
    installed.push({ slug, packageName: addonPkg.name, version: addonPkg.version || '0.0.0', destination: dest });
  }
  writeFileSync(pkgPath, JSON.stringify(localPkg, null, 2));

  return { paths, installed, packageJsonPath: pkgPath };
}

export function formatPreparedEnvironment(result: PrepareResult): string[] {
  return [
    `PICLAW_PREP_ROOT=${result.paths.root}`,
    `PICLAW_WORKSPACE=${result.paths.workspace}`,
    `HOME=${result.paths.home}`,
    `PICLAW_STORE=${result.paths.store}`,
    `PICLAW_DATA=${result.paths.data}`,
    `PICLAW_PI_AGENT_DIR=${result.paths.profile}`,
    `PI_CODING_AGENT_DIR=${result.paths.profile}`,
    `XDG_CONFIG_HOME=${result.paths.xdgConfig}`,
    `XDG_CACHE_HOME=${result.paths.xdgCache}`,
    `XDG_DATA_HOME=${result.paths.xdgData}`,
    `TMPDIR=${result.paths.tmp}`,
    `TMP=${result.paths.tmp}`,
    `TEMP=${result.paths.tmp}`,
  ];
}

if (import.meta.main) {
  const result = prepareAddonTestInstance();
  for (const line of formatPreparedEnvironment(result)) console.log(line);
  console.log(`Prepared ${result.installed.length} add-on(s): ${result.installed.map((addon) => `${addon.slug} (${addon.packageName}@${addon.version})`).join(', ') || '(none)'}`);
}
