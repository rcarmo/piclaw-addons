import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "drawio-lifecycle-"));
  roots.push(root);
  // Real module isolation: native selection deliberately cannot reset to legacy.
  // Bun canonicalizes query-string imports, so copy the exact source instead.
  copyFileSync(join(import.meta.dir, "index.ts"), join(root, "index.ts"));
  symlinkSync(join(import.meta.dir, "tool.ts"), join(root, "tool.ts"));
  const api: typeof import("./index") = await import(join(root, "index.ts"));
  const baseDir = join(root, "addon");
  const cacheDir = join(root, "cache", "vendor");
  mkdirSync(baseDir);
  await Bun.Archive.write(join(baseDir, "vendor.tar.gz"), { "index.html": "tiny vendor", "app.js": "app" }, { compress: "gzip" });
  const route = (path = "index.html") => api.handleRoute(new Request(`http://localhost/drawio/${path}`), `/drawio/${path}`) as Promise<Response>;
  return { api, root, baseDir, cacheDir, cwd: join(root, "cwd"), route };
}

function heldExtraction() {
  const original = Bun.Archive.prototype.extract;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  Bun.Archive.prototype.extract = async function(...args: Parameters<typeof original>) {
    calls++;
    entered();
    await gate;
    return original.apply(this, args);
  };
  return { started, release, get calls() { return calls; }, restore() { Bun.Archive.prototype.extract = original; } };
}

test("staging cleanup uncertainty seals native owner and cached close rejection", async () => {
  const f = await fixture();
  const host = f.api.bindDrawioVendorHost({ ...f, assertCurrent() {} });
  const held = heldExtraction();
  const originalRm = fs.rmSync;
  let faultCalls = 0;
  let staging: string | undefined;
  const fault = spyOn(fs, "rmSync").mockImplementation((path, options) => {
    if (String(path).startsWith(`${f.cacheDir}.tmp-`)) {
      faultCalls++;
      staging = String(path);
      throw new Error("injected staging cleanup failure");
    }
    return originalRm(path, options);
  });
  try {
    const preparation = host.prepare();
    const failed = preparation.catch(error => error);
    await held.started;
    const sibling = join(f.root, "cache", "other-owner");
    writeFileSync(sibling, "preserved");
    const closing = host.close();
    const closeFailure = closing.catch(error => error);
    held.release();
    expect(await failed).toBeInstanceOf(f.api.DrawioVendorCleanupError);
    expect(await closeFailure).toBeInstanceOf(f.api.DrawioVendorCleanupError);
    expect(faultCalls).toBeGreaterThan(0);
    expect(host.close()).toBe(closing);
    await expect(host.close()).rejects.toBeInstanceOf(f.api.DrawioVendorCleanupError);
    expect(host.directory).toBeUndefined();
    expect(() => f.api.bindDrawioVendorHost({ ...f, assertCurrent() {} })).toThrow("already owned");
    expect(existsSync(f.cacheDir)).toBe(false);
    expect(existsSync(staging!)).toBe(true);
    expect(readFileSync(sibling, "utf8")).toBe("preserved");
    expect((await f.route()).status).toBe(503);
  } finally {
    fault.mockRestore(); held.release(); held.restore();
    // Fixture-only manual cleanup; no reset or replacement grant is exposed.
    if (staging) originalRm(staging, { recursive: true, force: true });
  }
});

test("native binding refuses a legacy extraction in progress", async () => {
  const f = await fixture();
  const held = heldExtraction();
  try {
    const legacy = f.api.ensureDrawioVendorDir(f.baseDir, f.cwd, f.cacheDir);
    await held.started;
    expect(() => f.api.bindDrawioVendorHost({ ...f, assertCurrent() {} })).toThrow("already owned");
    held.release();
    expect(await legacy).toBe(f.cacheDir);
  } finally { held.release(); held.restore(); }
});

test("native startup is explicit, deduplicated, read-only and canonically contained", async () => {
  const f = await fixture();
  let valid = true;
  const options = { ...f, assertCurrent() { expect(this).toBe(options); if (!valid) throw new Error("revoked"); } };
  const host = f.api.bindDrawioVendorHost(options);
  const held = heldExtraction();
  try {
    expect((await f.route()).status).toBe(503);
    expect(existsSync(f.cacheDir)).toBe(false);
    expect(() => f.api.bindDrawioVendorHost(options)).toThrow("already owned");
    const first = host.prepare();
    expect(host.prepare()).toBe(first);
    await held.started;
    // Serving must not join or trigger a still-running preparation.
    // A microtask sentinel makes this fail promptly if route() waits for it.
    const during = await Promise.race([f.route(), new Promise<undefined>(resolve => setTimeout(resolve, 0))]);
    expect(during?.status).toBe(503);
    expect(existsSync(f.cacheDir)).toBe(false);
    held.release();
    await first;
    expect(held.calls).toBe(1);
    expect((await f.route()).status).toBe(200);
    expect(await (await f.route()).text()).toBe("tiny vendor");
    writeFileSync(join(f.root, "secret"), "outside");
    symlinkSync(join(f.root, "secret"), join(f.cacheDir, "leak"));
    symlinkSync(join(f.cacheDir, "app.js"), join(f.cacheDir, "inside"));
    expect((await f.route("leak")).status).toBe(403);
    expect((await f.route("inside")).status).toBe(200);
    valid = false;
    options.assertCurrent = () => {}; // Cannot renew the captured grant.
    expect((await f.route()).status).toBe(503);
    await host.close();
    expect((await f.route()).status).toBe(503);
    expect(held.calls).toBe(1);
    const next = f.api.bindDrawioVendorHost({ ...f, assertCurrent() {} });
    await next.prepare();
    await host.close(); // An old close cannot unbind the replacement.
    expect((await f.route()).status).toBe(200);
    expect(held.calls).toBe(1);
    await next.close();
  } finally { held.release(); held.restore(); await host.close(); }
});

test("revocation during async extraction prevents publication and cleans only owned staging", async () => {
  const f = await fixture();
  let valid = true;
  const options = { ...f, assertCurrent() { if (!valid) throw new Error("revoked"); } };
  const host = f.api.bindDrawioVendorHost(options);
  const held = heldExtraction();
  try {
    const preparation = host.prepare();
    const rejected = preparation.catch((error: Error) => error);
    await held.started;
    const sibling = join(f.root, "cache", "other-owner");
    writeFileSync(sibling, "preserved");
    valid = false;
    options.assertCurrent = () => {};
    let closed = false;
    const closing = host.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(() => f.api.bindDrawioVendorHost({ ...f, assertCurrent() {} })).toThrow();
    expect((await f.route()).status).toBe(503);
    held.release();
    expect(await rejected).toBeInstanceOf(Error);
    await closing;
    expect(existsSync(join(f.cacheDir, "index.html"))).toBe(false);
    expect(readdirSync(join(f.root, "cache"))).toEqual(["other-owner"]);
    expect(readFileSync(sibling, "utf8")).toBe("preserved");
    const next = await f.api.prepareDrawioVendor({ ...f, assertCurrent() {} });
    expect(next.directory).toBe(f.cacheDir);
    expect((await f.route()).status).toBe(200);
    await next.close();
  } finally { held.release(); held.restore(); await host.close(); }
});

