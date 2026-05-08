import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoDir = import.meta.dir;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function importStandaloneAddon(slug: "autoresearch" | "cheapskate" | "delegate" | "editable-table" | "goal" | "image-processing" | "imap" | "kanban-editor" | "mindmap" | "office-viewer" | "plan-sidebar" | "portainer" | "proxmox" | "session-tree" | "skill-model-effort" | "vent") {
  const tempRoot = mkdtempSync(join(tmpdir(), `piclaw-addon-${slug}-`));
  tempDirs.push(tempRoot);

  const packageDir = join(tempRoot, `piclaw-addon-${slug}`);
  cpSync(join(repoDir, "addons", slug), packageDir, { recursive: true });
  symlinkSync(join(repoDir, "node_modules"), join(tempRoot, "node_modules"), "dir");

  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  return import(pathToFileURL(join(packageDir, manifest.main || "index.ts")).href);
}

test("standalone piclaw-addon-autoresearch imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("autoresearch");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-cheapskate imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("cheapskate");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-delegate imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("delegate");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-editable-table imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("editable-table");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-goal imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("goal");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-image-processing imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("image-processing");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-imap imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("imap");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-kanban-editor imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("kanban-editor");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-mindmap imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("mindmap");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-office-viewer imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("office-viewer");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-plan-sidebar imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("plan-sidebar");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-portainer imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("portainer");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-proxmox imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("proxmox");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-session-tree imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("session-tree");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-skill-model-effort imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("skill-model-effort");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-vent imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("vent");
  expect(typeof mod.default).toBe("function");
});
