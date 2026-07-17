import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

async function importStandaloneAddon(slug: "autoresearch" | "cheapskate" | "codex-conversion" | "delegate" | "editable-table" | "goal" | "image-processing" | "imap" | "kanban-editor" | "lite-term" | "mindmap" | "office-viewer" | "plan-sidebar" | "portainer" | "proxmox" | "session-tree" | "skill-model-effort" | "smart-compaction" | "vent" | "voice-pipeline" | "win-ui" | "yolo-vibe") {
  const tempRoot = mkdtempSync(join(tmpdir(), `piclaw-addon-${slug}-`));
  tempDirs.push(tempRoot);

  const packageDir = join(tempRoot, `piclaw-addon-${slug}`);
  cpSync(join(repoDir, "addons", slug), packageDir, { recursive: true });

  const manifestPath = join(packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
    const rootManifest = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
    manifest.devDependencies ||= {};
    for (const peerName of Object.keys(manifest.peerDependencies ?? {})) {
      const pinned = rootManifest.devDependencies?.[peerName];
      if (typeof pinned === "string") manifest.devDependencies[peerName] = pinned;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const installed = Bun.spawnSync(["bun", "install", "--force"], {
      cwd: packageDir,
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(repoDir, ".tmp", "standalone-bun-cache") },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (installed.exitCode !== 0) {
      throw new Error(`Failed to install runtime dependencies for ${slug}: ${installed.stderr.toString()}`);
    }
  } else {
    symlinkSync(join(repoDir, "node_modules"), join(tempRoot, "node_modules"), "dir");
  }
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

test("standalone piclaw-addon-codex-conversion imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("codex-conversion");
  expect(typeof mod.default).toBe("function");
}, 300_000);

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
}, 120_000);

test("standalone piclaw-addon-imap imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("imap");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-kanban-editor imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("kanban-editor");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-lite-term imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("lite-term");
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

test("standalone piclaw-addon-smart-compaction imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("smart-compaction");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-vent imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("vent");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-voice-pipeline imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("voice-pipeline");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-win-ui imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("win-ui");
  expect(typeof mod.default).toBe("function");
});

test("standalone piclaw-addon-yolo-vibe imports outside the monorepo root", async () => {
  const mod = await importStandaloneAddon("yolo-vibe");
  expect(typeof mod.default).toBe("function");
});
