import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;

test("ghostty terminal add-on declares a browser pane entry", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.name).toBe("@rcarmo/piclaw-addon-ghostty-terminal");
  expect(pkg.pi.web.entries).toEqual(["web/index.js"]);
});

test("ghostty terminal add-on owns ghostty-web browser assets", () => {
  const jsPath = join(root, "web/vendor/ghostty-web.js");
  const wasmPath = join(root, "web/vendor/ghostty-vt.wasm");
  const metaPath = join(root, "web/vendor/ghostty-web.meta.json");

  expect(existsSync(jsPath)).toBe(true);
  expect(existsSync(wasmPath)).toBe(true);
  expect(existsSync(metaPath)).toBe(true);

  const bundle = readFileSync(join(root, "web/index.js"), "utf8");
  expect(bundle).toContain("%40rcarmo%2Fpiclaw-addon-ghostty-terminal");
  expect(bundle).toContain("ghostty-web.js");
  expect(bundle).toContain("ghostty-vt.wasm");
  expect(bundle).toContain("registered Ghostty terminal panes");
});
