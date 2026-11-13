import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = import.meta.dir;

// Browser web entries are served as individual add-on assets. The asset route
// transpiles exactly the requested file; it does not add or rewrite extensions.
function runtimeRelativeImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const specs: string[] = [];
  for (const match of code.matchAll(/\b(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["'](\.\.?\/[^"']+)["']/g)) {
    if (match[2] || /^\{\s*type\s/.test(match[3]!)) continue;
    specs.push(match[4]!);
  }
  for (const match of code.matchAll(/\bimport\s+["'](\.\.?\/[^"']+)["']/g)) specs.push(match[1]!);
  for (const match of code.matchAll(/\bimport\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g)) specs.push(match[1]!);
  return specs;
}

function webSources(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["vendor", "node_modules", ".artifacts"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) files.push(path);
    }
  };
  for (const addon of readdirSync(join(root, "addons"))) {
    const web = join(root, "addons", addon, "web");
    if (existsSync(web)) walk(web);
  }
  return files;
}

test("runtime imports in add-on web entries name existing files with explicit extensions", () => {
  const unresolved: string[] = [];
  for (const file of webSources()) {
    for (const spec of runtimeRelativeImports(readFileSync(file, "utf8"))) {
      const target = resolve(dirname(file), spec);
      if (!/\.(ts|tsx|js|mjs|json)$/.test(spec) || !existsSync(target) || !statSync(target).isFile()) {
        unresolved.push(`${file.slice(root.length + 1)} -> ${spec}`);
      }
    }
  }
  expect(unresolved).toEqual([]);
});

test("the import scan distinguishes erased type imports from runtime imports", () => {
  expect(runtimeRelativeImports([
    "import type { A } from './types.js';",
    "import { type B } from './erased.js';",
    "import { icon } from './icon';",
    "export { value } from '../shared.ts';",
    "import './side-effect.ts';",
    "await import('./lazy.ts');",
  ].join("\n"))).toEqual(["./icon", "../shared.ts", "./side-effect.ts", "./lazy.ts"]);
});
