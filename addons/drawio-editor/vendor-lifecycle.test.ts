import { afterEach, expect, spyOn, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "drawio-lifecycle-")); roots.push(root);
  // Each test owns a module lifetime. Native selection cannot fall back to standalone serving.
  copyFileSync(join(import.meta.dir, "index.ts"), join(root, "index.ts"));
  symlinkSync(join(import.meta.dir, "tool.ts"), join(root, "tool.ts"));
  const api: typeof import("./index") = await import(join(root, "index.ts"));
  const baseDir = join(root, "addon"), cacheDir = join(root, "cache", "vendor"), vendor = join(baseDir, "vendor");
  mkdirSync(baseDir);
  const install = () => { mkdirSync(vendor); writeFileSync(join(vendor, "index.html"), "installed editor"); };
  const route = async (path = "index.html", method = "GET") => (
    await api.handleRoute(new Request(`http://localhost/drawio/${path}`, { method }), `/drawio/${path}`)
  )!;
  return { api, root, baseDir, cacheDir, vendor, route, install };
}

test("archive-only packages refuse preparation without opening the archive or creating a cache", async () => {
  const f = await fixture();
  writeFileSync(join(f.baseDir, "vendor.tar.gz"), "must not open");
  const host = f.api.bindDrawioVendorHost({ ...f, assertCurrent() {} });
  const file = spyOn(Bun, "file");
  try {
    await expect(host.prepare()).rejects.toThrow("installed vendor files");
    expect((await f.route()).status).toBe(503);
    expect(file).not.toHaveBeenCalled();
    expect(existsSync(f.cacheDir)).toBe(false);
  } finally { file.mockRestore(); await host.close(); }
});

test("startup and HEAD do not read payloads; GET streams only a requested, contained file", async () => {
  const f = await fixture(); f.install();
  let valid = true;
  const options = { ...f, assertCurrent() { expect(this).toBe(options); if (!valid) throw Error("revoked"); } };
  const host = f.api.bindDrawioVendorHost(options), file = spyOn(Bun, "file");
  try {
    expect((await f.route()).status).toBe(503);
    expect(() => f.api.bindDrawioVendorHost(options)).toThrow("already owned");
    const prepare = host.prepare(); expect(host.prepare()).toBe(prepare); await prepare;
    expect(host.directory).toBe(f.vendor);
    const head = await f.route("index.html", "HEAD"); expect(head.status).toBe(200); expect(head.body).toBeNull();
    expect(file).not.toHaveBeenCalled();
    writeFileSync(join(f.root, "secret"), "outside");
    symlinkSync(join(f.root, "secret"), join(f.vendor, "leak"));
    expect((await f.route("leak")).status).toBe(403);
    expect(file).not.toHaveBeenCalled();
    expect(await (await f.route()).text()).toBe("installed editor");
    expect(file).toHaveBeenCalledTimes(1); expect(file).toHaveBeenCalledWith(join(f.vendor, "index.html"));
    valid = false; options.assertCurrent = () => {};
    expect((await f.route()).status).toBe(503);
    await host.close(); await expect(host.prepare()).rejects.toThrow("closed");
    expect((await f.route()).status).toBe(503);
    const next = f.api.bindDrawioVendorHost({ ...f, assertCurrent() {} });
    try {
      await next.prepare(); await host.close(); // Old cleanup cannot revoke the replacement.
      expect((await f.route("index.html", "HEAD")).status).toBe(200);
      expect(file).toHaveBeenCalledTimes(1);
      expect(existsSync(f.cacheDir)).toBe(false);
    } finally { await next.close(); }
  } finally { file.mockRestore(); await host.close(); }
});
