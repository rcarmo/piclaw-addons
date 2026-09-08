import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { packageDirForName, prepareAddonTestInstance, formatPreparedEnvironment } from "./prepare-addon-test-instance.js";
import { preparedInstanceEnvironment } from '../../../scripts/run-test-instance.js';

test("preparation ignores inherited live workspace and skips source symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "addon-prep-fixture-"));
  let prepared: ReturnType<typeof prepareAddonTestInstance> | undefined;
  try {
    const repo = join(root, "repo"), addon = join(repo, "addons/demo"), live = join(root, "live");
    mkdirSync(addon, { recursive: true }); mkdirSync(live);
    writeFileSync(join(addon, "package.json"), JSON.stringify({ name: "@test/demo", version: "1.0.0" }));
    writeFileSync(join(addon, "index.ts"), "export default 1;");
    mkdirSync(join(repo, 'node_modules/dependency'), { recursive: true });
    writeFileSync(join(repo, 'node_modules/dependency/keep'), 'original dependency');
    writeFileSync(join(live, "sentinel"), "do not change");
    symlinkSync(join(live, "sentinel"), join(addon, "secret-link"));
    prepared = prepareAddonTestInstance({ repoRoot: repo, env: { PICLAW_WORKSPACE: live, PICLAW_ADDON: "demo" } });
    expect(prepared.paths.workspace).not.toBe(live);
    expect(readFileSync(join(live, "sentinel"), "utf8")).toBe("do not change");
    expect(existsSync(join(prepared.installed[0]!.destination, "secret-link"))).toBe(false);
    writeFileSync(join(prepared.installed[0]!.destination, 'node_modules/dependency/keep'), 'test mutation');
    expect(readFileSync(join(repo, 'node_modules/dependency/keep'), 'utf8')).toBe('original dependency');
    expect(formatPreparedEnvironment(prepared).some((s) => s.startsWith("PICLAW_PI_AGENT_DIR="))).toBe(true);
    expect(formatPreparedEnvironment(prepared).some((s) => s.startsWith("PICLAW_PROFILE="))).toBe(false);
    const input = Object.fromEntries(formatPreparedEnvironment(prepared).map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    const env = preparedInstanceEnvironment({ ...input, PORTAINER_RELAY: 'live', GITHUB_PICLAW_BOT_PAT: 'live', PICLAW_INTERNAL_SECRET: 'live', PICLAW_E2E_INTERNAL_SECRET: 'test-only' });
    expect(env.PORTAINER_RELAY).toBeUndefined(); expect(env.GITHUB_PICLAW_BOT_PAT).toBeUndefined();
    expect(env.PICLAW_INTERNAL_SECRET).toBe('test-only');
    expect(() => preparedInstanceEnvironment({ ...input, HOME: live })).toThrow();
  } finally {
    if (prepared) rmSync(prepared.paths.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("package destination rejects traversal and accepts scoped names", () => {
  for (const name of ["../foo", "@scope/../../foo", "/tmp/foo", "@../foo", "@scope/..", "foo/bar", "foo\\bar"]) expect(() => packageDirForName("/tmp/owned/node_modules", name)).toThrow();
  expect(packageDirForName("/tmp/owned/node_modules", "@scope/name")).toBe("/tmp/owned/node_modules/@scope/name");
});
