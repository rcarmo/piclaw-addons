import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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

async function importStandaloneAddon(slug: "autoresearch" | "editable-table" | "imap" | "kanban-editor" | "portainer" | "proxmox" | "vent") {
  const tempRoot = mkdtempSync(join(tmpdir(), `piclaw-addon-${slug}-`));
  tempDirs.push(tempRoot);

  const packageDir = join(tempRoot, `piclaw-addon-${slug}`);
  cpSync(join(repoDir, "addons", slug), packageDir, { recursive: true });
  symlinkSync(join(repoDir, "node_modules"), join(tempRoot, "node_modules"), "dir");

  return import(pathToFileURL(join(packageDir, "index.ts")).href);
}

test("standalone piclaw-addon-autoresearch imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("autoresearch");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-editable-table imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("editable-table");
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

test("standalone piclaw-addon-portainer imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("portainer");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-proxmox imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("proxmox");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-vent imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("vent");
  expect(typeof mod.default).toBe("function");
});
