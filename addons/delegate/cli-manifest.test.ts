import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveDelegateCliCommand, resolvePackagePiCliPath, resolvePiPackageCli } from "./delegate.ts";

const name = "@earendil-works/pi-coding-agent";
function fixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "delegate-cli-manifest-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function put(root: string, path: string, content: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}
function pkg(root: string, bin = "dist/bundle/cli.js") {
  put(root, bin, "throw new Error('resolver must not execute package code');\n");
  return put(root, "package.json", JSON.stringify({ name, version: "1.0.0", bin: { pi: bin } }));
}

describe("Delegate published package CLI", () => {
  for (const bin of ["dist/bundle/cli.js", "dist/cli.js", "./dist/bundle/cli.js"]) {
    test(`uses manifest bin.pi ${bin}`, () => fixture(root => {
      const manifest = pkg(root, bin);
      put(root, "dist/unused-cli.js", "throw new Error('wrong entry');");
      expect(resolvePiPackageCli(manifest)).toBe(join(root, bin));
    }));
  }

  test("rejects malformed metadata, foreign packages and absent or invalid bins", () => fixture(root => {
    const manifest = pkg(root);
    for (const value of ["{", "null", "[]", JSON.stringify({ name: "other", bin: { pi: "dist/bundle/cli.js" } }), ...[undefined, "dist/bundle/cli.js", [], {}, { pi: "" }, { pi: 1 }, { pi: {} }].map(bin => JSON.stringify({ name, bin }))]) {
      writeFileSync(manifest, value);
      expect(resolvePiPackageCli(manifest), value).toBeNull();
    }
    expect(resolvePiPackageCli(join(root, "absent.json"))).toBeNull();
  }));

  test("rejects escapes, missing files, directories and escaping symlinks", () => fixture(root => {
    const packageRoot = join(root, "package");
    const manifest = pkg(packageRoot);
    const outside = put(root, "outside.js", "throw new Error('outside');");
    symlinkSync(outside, join(packageRoot, "escape.js"));
    for (const bin of [outside, "C:\\outside.js", "../outside.js", "dist/../../outside.js", "..\\outside.js", "escape.js", "absent.js", "dist", "\u0000"]) {
      writeFileSync(manifest, JSON.stringify({ name, bin: { pi: bin } }));
      expect(resolvePiPackageCli(manifest), bin).toBeNull();
    }
  }));

  test("supports a symlinked package root and an internal bin symlink", () => fixture(root => {
    const real = join(root, "real"); const manifest = pkg(real);
    symlinkSync(join(real, "dist/bundle/cli.js"), join(real, "cli.js"));
    writeFileSync(manifest, JSON.stringify({ name, bin: { pi: "cli.js" } }));
    const link = join(root, "linked"); symlinkSync(real, link, "dir");
    expect(resolvePiPackageCli(join(link, "package.json"))).toBe(join(real, "dist/bundle/cli.js"));
  }));

  test("finds a manifest through the public root when package.json is export-hidden", () => fixture(root => {
    const manifest = pkg(root);
    const entry = put(root, "dist/index.js", "throw new Error('must not import');");
    const attempts: string[] = [];
    const result = resolvePackagePiCliPath(specifier => {
      attempts.push(specifier);
      if (specifier === name) return entry;
      throw new Error("ERR_PACKAGE_PATH_NOT_EXPORTED");
    });
    expect(result).toBe(join(root, "dist/bundle/cli.js"));
    expect(attempts).toEqual([`${name}/package.json`, name]);
    expect(resolvePackagePiCliPath(() => manifest)).toBe(result);
  }));

  test("missing public root or invalid discovered manifest gives no candidate", () => fixture(root => {
    expect(resolvePackagePiCliPath(() => { throw new Error("not installed"); })).toBeNull();
    const manifest = put(root, "package.json", "{}");
    expect(resolvePackagePiCliPath(() => manifest)).toBeNull();
  }));

  test("adjacent package precedes global manifest and PATH; override remains first", () => fixture(root => {
    const adjacent = resolvePiPackageCli(pkg(join(root, "adjacent")))!;
    const globalRoot = join(root, "install/global/node_modules", name);
    const globalCli = resolvePiPackageCli(pkg(globalRoot))!;
    const opts = { env: { BUN_INSTALL: root, PATH: "/fake" }, execPath: process.execPath, resolvePackageCli: () => adjacent, isExecutable: () => true };
    expect(resolveDelegateCliCommand(opts).argsPrefix).toEqual([adjacent]);
    expect(resolveDelegateCliCommand({ ...opts, resolvePackageCli: () => null }).argsPrefix).toEqual([globalCli]);
    const override = resolveDelegateCliCommand({ ...opts, env: { PI_DELEGATE_CLI: "custom --flag" }, resolvePackageCli: () => { throw new Error("override must win"); } });
    expect(override).toEqual({ command: "custom", argsPrefix: ["--flag"], label: "custom --flag" });
  }));

  test("invalid package candidates retain PATH and literal fallback", () => {
    const opts = { env: { BUN_INSTALL: "/missing", PATH: "/fake" }, execPath: process.execPath, resolvePackageCli: () => null, exists: () => false };
    expect(resolveDelegateCliCommand({ ...opts, isExecutable: path => path === "/fake/pi" })).toEqual({ command: "/fake/pi", argsPrefix: [], label: "/fake/pi" });
    expect(resolveDelegateCliCommand({ ...opts, isExecutable: () => false })).toEqual({ command: "pi", argsPrefix: [], label: "pi" });
  });
});
