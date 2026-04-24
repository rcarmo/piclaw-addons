#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface AgentSkillEntry {
  name?: string;
  path?: string;
}

interface AddonPackage {
  name?: string;
  version?: string;
  description?: string;
  keywords?: string[];
  main?: string;
  peerDependencies?: Record<string, string>;
  pi?: {
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
    themes?: string[];
    image?: string;
    video?: string;
  };
  piclaw?: {
    type?: string;
    compatibleVersions?: string;
    tags?: string[];
    skills?: string[];
  };
  agents?: {
    skills?: AgentSkillEntry[];
  };
}

const CORE_PEER_DEPENDENCIES = [
  '@mariozechner/pi-coding-agent',
  '@sinclair/typebox',
] as const;

type CorePeerDependency = (typeof CORE_PEER_DEPENDENCIES)[number];

interface CatalogEntry {
  slug: string;
  name: string;
  version: string;
  type: string;
  description: string;
  path: string;
  tags: string[];
  skills: string[];
  install: {
    kind: 'npm';
    spec: string;
    piSource: string;
  };
}

const repoRoot = '/workspace/piclaw-addons';
const addonsDir = join(repoRoot, 'addons');
const rootPackagePath = join(repoRoot, 'package.json');
const catalogPath = join(repoRoot, 'catalog.json');
const extensionsDir = join(repoRoot, 'extensions');
const skillsDir = join(repoRoot, 'skills');
const writeMode = process.argv.includes('--write');
const checkMode = process.argv.includes('--check');

function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function listAddonSlugs(): Promise<string[]> {
  const entries = await readdir(addonsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name.startsWith('.')) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listSourceFiles(fullPath));
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mts|cts)$/.test(entry.name)) out.push(fullPath);
  }
  return out;
}

async function validateCorePeerDependencies(addonRoot: string, slug: string, pkg: AddonPackage): Promise<void> {
  const files = await listSourceFiles(addonRoot);
  const imported = new Set<CorePeerDependency>();
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const dep of CORE_PEER_DEPENDENCIES) {
      if (content.includes(`"${dep}"`) || content.includes(`'${dep}'`)) imported.add(dep);
    }
  }
  for (const dep of imported) {
    if (pkg.peerDependencies?.[dep] !== '*') {
      throw new Error(`addons/${slug}/package.json: ${dep} must be declared in peerDependencies with "*"`);
    }
  }
}

async function buildMetadata() {
  const slugs = await listAddonSlugs();
  const catalogEntries: CatalogEntry[] = [];
  const extensionPaths: string[] = [];
  const skillRoots: string[] = [];
  const agentSkills: AgentSkillEntry[] = [];

  for (const slug of slugs) {
    const addonRoot = join(addonsDir, slug);
    const pkgPath = join(addonRoot, 'package.json');
    const pkg = await readJson<AddonPackage>(pkgPath);

    if (!pkg.name) throw new Error(`addons/${slug}/package.json: missing name`);
    if (!pkg.version) throw new Error(`addons/${slug}/package.json: missing version`);
    if (!pkg.description) throw new Error(`addons/${slug}/package.json: missing description`);
    if (!pkg.pi?.extensions?.length) throw new Error(`addons/${slug}/package.json: missing pi.extensions`);
    if (!(pkg.keywords || []).includes('pi-package')) {
      throw new Error(`addons/${slug}/package.json: keywords must include "pi-package"`);
    }

    await validateCorePeerDependencies(addonRoot, slug, pkg);

    for (const ext of pkg.pi.extensions) {
      const rel = join('addons', slug, ext).replaceAll('\\', '/');
      extensionPaths.push(rel);
      if (!existsSync(join(repoRoot, rel))) {
        throw new Error(`addons/${slug}/package.json: missing extension target ${rel}`);
      }
    }

    const declaredAgentSkills = pkg.agents?.skills || [];
    const addonSkillNames = declaredAgentSkills
      .map((entry) => entry?.name?.trim())
      .filter((name): name is string => Boolean(name));

    if (declaredAgentSkills.length) {
      skillRoots.push(`addons/${slug}/skills`);
      for (const entry of declaredAgentSkills) {
        if (!entry?.name || !entry?.path) {
          throw new Error(`addons/${slug}/package.json: every agents.skills entry needs name and path`);
        }
        const normalizedPath = entry.path.replace(/^\.\//, '');
        const relPath = `./addons/${slug}/${normalizedPath}`;
        agentSkills.push({ name: entry.name, path: relPath });
        if (!existsSync(join(repoRoot, relPath.replace(/^\.\//, '')))) {
          throw new Error(`addons/${slug}/package.json: missing skill path ${relPath}`);
        }
      }
    }

    catalogEntries.push({
      slug,
      name: pkg.name,
      version: pkg.version,
      type: pkg.piclaw?.type || 'extension',
      description: pkg.description,
      path: `addons/${slug}`,
      tags: dedupeSorted(pkg.piclaw?.tags || []),
      skills: dedupeSorted(addonSkillNames),
      install: {
        kind: 'npm',
        spec: `${pkg.name}@${pkg.version}`,
        piSource: `npm:${pkg.name}@${pkg.version}`,
      },
    });
  }

  const rootPackage = await readJson<Record<string, unknown>>(rootPackagePath);
  const nextRootPackage = {
    ...rootPackage,
    keywords: dedupeSorted([...(Array.isArray(rootPackage.keywords) ? rootPackage.keywords as string[] : []), 'pi-package']),
    files: dedupeSorted(['addons', 'catalog.json', 'README.md', 'LICENSE']),
    pi: {
      ...(typeof rootPackage.pi === 'object' && rootPackage.pi ? rootPackage.pi as Record<string, unknown> : {}),
      extensions: extensionPaths,
      skills: dedupeSorted(skillRoots),
    },
    agents: {
      ...(typeof rootPackage.agents === 'object' && rootPackage.agents ? rootPackage.agents as Record<string, unknown> : {}),
      skills: agentSkills.sort((a, b) => `${a.name}:${a.path}`.localeCompare(`${b.name}:${b.path}`)),
    },
  };

  const nextCatalog = {
    version: 2,
    source: 'github:rcarmo/piclaw-addons',
    addons: catalogEntries,
  };

  return {
    nextRootPackage: stableStringify(nextRootPackage),
    nextCatalog: stableStringify(nextCatalog),
    generatedExtensionPaths: extensionPaths,
    generatedSkillRoots: skillRoots,
  };
}

async function maybeWrite(path: string, content: string): Promise<boolean> {
  const current = await readFile(path, 'utf8');
  if (current === content) return false;
  if (writeMode) await writeFile(path, content, 'utf8');
  return true;
}

async function main() {
  const { nextRootPackage, nextCatalog } = await buildMetadata();
  const changed: string[] = [];

  if (await maybeWrite(rootPackagePath, nextRootPackage)) changed.push(relative(repoRoot, rootPackagePath));
  if (await maybeWrite(catalogPath, nextCatalog)) changed.push(relative(repoRoot, catalogPath));

  if (writeMode) {
    if (existsSync(extensionsDir)) {
      await rm(extensionsDir, { recursive: true, force: true });
      changed.push('extensions/');
    }
    if (existsSync(skillsDir)) {
      await rm(skillsDir, { recursive: true, force: true });
      changed.push('skills/');
    }
  }

  if (changed.length) {
    console.log(changed.map((entry) => `updated ${entry}`).join('\n'));
    if (checkMode && !writeMode) process.exit(1);
    return;
  }

  console.log('metadata already in sync');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
