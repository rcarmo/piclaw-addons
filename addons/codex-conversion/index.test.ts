import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const addonDir = import.meta.dir;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("codex-conversion package keeps upstream attribution and runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(join(addonDir, "package.json"), "utf8"));

  expect(manifest.name).toBe("@rcarmo/piclaw-addon-codex-conversion");
  expect(manifest.pi.extensions).toEqual(["src/index.ts"]);
  expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
  expect(manifest.peerDependencies["@earendil-works/pi-ai"]).toBe("*");
  expect(manifest.peerDependencies["@earendil-works/pi-tui"]).toBe("*");
  expect(manifest.peerDependencies["@sinclair/typebox"]).toBe("*");
  expect(manifest.dependencies["node-pty"]).toBeTruthy();
  expect(manifest.dependencies["partial-json"]).toBeTruthy();
  expect(manifest.dependencies["tree-sitter-bash"]).toBeTruthy();
  expect(manifest.dependencies["web-tree-sitter"]).toBeTruthy();

  expect(readFileSync(join(addonDir, "LICENSE.upstream"), "utf8")).toContain("MIT License");
  expect(readFileSync(join(addonDir, "README.md"), "utf8")).toContain("IgorWarzocha/pi-codex-conversion");
});

test("codex-conversion source imports target Piclaw package names", () => {
  const files = collectTsFiles(join(addonDir, "src"));
  expect(files.length).toBeGreaterThan(10);
  const combined = files.map((file) => readFileSync(file, "utf8")).join("\n");

  expect(combined).not.toContain("@mariozechner/");
  expect(combined).not.toContain('from "typebox"');
  expect(combined).toContain("@earendil-works/pi-coding-agent");
  expect(combined).toContain("@earendil-works/pi-ai");
  expect(combined).toContain("@earendil-works/pi-tui");
  expect(combined).toContain("@sinclair/typebox");
});
