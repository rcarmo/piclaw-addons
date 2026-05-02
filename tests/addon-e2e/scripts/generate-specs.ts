#!/usr/bin/env bun
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

interface Scenario { name: string; steps: string[]; line: number; }
interface Feature { name: string; background: string[]; scenarios: Scenario[]; }

const repoRoot = resolve(import.meta.dir, '../../..');
const e2eRoot = resolve(import.meta.dir, '..');
const generatedRoot = join(e2eRoot, '.generated');
const addonsDir = join(repoRoot, 'addons');

function walk(dir: string, predicate: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, predicate));
    else if (predicate(full)) out.push(full);
  }
  return out.sort();
}

function discoverAddons(): string[] {
  const requested = process.env.PICLAW_ADDON || process.argv.find((arg) => !arg.startsWith('-'));
  if (requested && requested !== 'all') return requested.split(',').map((s) => s.trim()).filter(Boolean);
  return readdirSync(addonsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) => walk(join(addonsDir, slug, 'tests', 'features'), (p) => p.endsWith('.feature')).length > 0)
    .sort();
}

function parseFeature(path: string): Feature {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const feature: Feature = { name: basename(path), background: [], scenarios: [] };
  let mode: 'none' | 'background' | 'scenario' = 'none';
  let current: Scenario | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;
    if (line.startsWith('Feature:')) {
      feature.name = line.slice('Feature:'.length).trim();
      continue;
    }
    if (line.startsWith('Background:')) {
      mode = 'background';
      current = null;
      continue;
    }
    if (line.startsWith('Scenario:')) {
      current = { name: line.slice('Scenario:'.length).trim(), steps: [], line: i + 1 };
      feature.scenarios.push(current);
      mode = 'scenario';
      continue;
    }
    if (/^(Given|When|Then|And|But)\s+/.test(line)) {
      if (mode === 'background') feature.background.push(line);
      else if (current) current.steps.push(line);
      else throw new Error(`${path}:${i + 1}: step outside Background/Scenario`);
    }
  }
  return feature;
}

function specString(slug: string, featureFile: string, feature: Feature): string {
  const specDir = join(generatedRoot, slug);
  const commonImport = relative(specDir, join(e2eRoot, 'steps', 'common-addon.steps.ts')).replaceAll('\\', '/');
  const addonStepsPath = join(addonsDir, slug, 'tests', 'steps');
  const addonStepFiles = walk(addonStepsPath, (p) => /\.(ts|js|mts|mjs)$/.test(p));
  const addonImports = addonStepFiles.map((file, index) => {
    const rel = relative(specDir, file).replaceAll('\\', '/');
    return `import { steps as addonSteps${index} } from '${rel.startsWith('.') ? rel : `./${rel}`}';`;
  }).join('\n');
  const allSteps = ['...commonSteps', ...addonStepFiles.map((_, index) => `...addonSteps${index}`)].join(', ');
  const relFeature = relative(repoRoot, featureFile).replaceAll('\\', '/');

  const tests = feature.scenarios.map((scenario) => {
    const steps = [...feature.background, ...scenario.steps];
    return `  test(${JSON.stringify(scenario.name)}, async ({ authedPage: page }) => {\n` +
      `    const ctx = { page, addonSlug: ${JSON.stringify(slug)}, featureFile: ${JSON.stringify(relFeature)}, state: { addonSlug: ${JSON.stringify(slug)} } };\n` +
      `    const runner = createRunner(stepDefinitions, ctx);\n` +
      steps.map((step) => `    await runner.run(${JSON.stringify(step)});`).join('\n') +
      `\n  });`;
  }).join('\n\n');

  return `// Generated from ${relFeature}. Do not edit.\n` +
    `import { test } from '../../support/world';\n` +
    `import { createRunner } from '../../support/gherkin-runner';\n` +
    `import { steps as commonSteps } from '../../steps/common-addon.steps';\n` +
    `${addonImports ? `${addonImports}\n` : ''}\n` +
    `const stepDefinitions = [${allSteps}];\n\n` +
    `test.describe(${JSON.stringify(`${slug}: ${feature.name}`)}, () => {\n${tests}\n});\n`;
}

rmSync(generatedRoot, { recursive: true, force: true });
mkdirSync(generatedRoot, { recursive: true });

const slugs = discoverAddons();
for (const slug of slugs) {
  const featureFiles = walk(join(addonsDir, slug, 'tests', 'features'), (p) => p.endsWith('.feature'));
  if (!featureFiles.length) continue;
  const outDir = join(generatedRoot, slug);
  mkdirSync(outDir, { recursive: true });
  for (const featureFile of featureFiles) {
    const feature = parseFeature(featureFile);
    const rel = relative(join(addonsDir, slug, 'tests', 'features'), featureFile).replaceAll('\\', '/');
    const safeName = rel.replace(/\.feature$/, '.spec.ts').replace(/[^a-zA-Z0-9_.-]+/g, '-');
    writeFileSync(join(outDir, safeName), specString(slug, featureFile, feature), 'utf8');
  }
}

console.log(`Generated add-on E2E specs for ${slugs.length} add-on(s): ${slugs.join(', ') || '(none)'}`);
