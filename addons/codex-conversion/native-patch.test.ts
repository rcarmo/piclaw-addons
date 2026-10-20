import { test, expect } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeApplyPatchFactory } from "./src/native-patch.ts";
import { executePatch } from "./src/patch/core.ts";
import type { PatchFilePorts } from "./src/patch/paths.ts";
const patch = "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch";
function fixture(body: (cwd: string) => void) {
 const cwd = fs.mkdtempSync(join(tmpdir(), "codex-native-patch-"));
 try { body(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}
test("native and legacy patch result/file parity", () => fixture(cwd => {
 const legacy = join(cwd, "legacy"), native = join(cwd, "native");
 const expected = executePatch({ cwd: legacy, patchText: patch });
 const tool = createNativeApplyPatchFactory(fs)({ assertCurrent() {} }, native);
 expect(tool.execute({ input: patch })).toEqual(expected);
 expect(fs.readFileSync(join(native, "a.txt"), "utf8")).toBe(fs.readFileSync(join(legacy, "a.txt"), "utf8"));
}));
test("revocation between mkdir and write prevents the actual write", () => fixture(cwd => {
 let live = true;
 const files = { ...fs, mkdirSync(...args: Parameters<typeof fs.mkdirSync>) {
  const result = fs.mkdirSync(...args); live = false; return result;
 } } as PatchFilePorts;
 const tool = createNativeApplyPatchFactory(files)({ assertCurrent() { if (!live) throw Error("revoked"); } }, cwd);
 expect(() => tool.execute({ input: patch })).toThrow("revoked");
 expect(fs.existsSync(join(cwd, "a.txt"))).toBe(false);
}));
test("wrong session and stale replay cannot reach ports", () => fixture(cwd => {
 let session = "owner", calls = 0;
 const tool = createNativeApplyPatchFactory({ ...fs, existsSync(path) { calls++; return fs.existsSync(path); } })({
  assertCurrent() { if (session !== "owner") throw Error("wrong session"); }
 }, cwd);
 session = "other";
 expect(() => tool.execute({ input: patch })).toThrow("wrong session");
 expect(calls).toBe(0);
 session = "owner"; tool.dispose();
 expect(() => tool.execute({ input: patch })).toThrow("Disposed");
 expect(calls).toBe(0);
}));
test("revocation before update read and delete prevents filesystem access", () => fixture(cwd => {
 fs.writeFileSync(join(cwd, "a.txt"), "hello\n");
 let live = true, reads = 0, deletes = 0;
 const files = { ...fs,
  existsSync(path) { const result = fs.existsSync(path); live = false; return result; },
  readFileSync(...args: any[]) { reads++; return (fs.readFileSync as any)(...args); },
  unlinkSync(path) { deletes++; fs.unlinkSync(path); }
 } as PatchFilePorts;
 const factory = createNativeApplyPatchFactory(files);
 const authority = { assertCurrent() { if (!live) throw Error("revoked"); } };
 expect(() => factory(authority, cwd).execute({ input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-hello\n+world\n*** End Patch" })).toThrow("revoked");
 expect(reads).toBe(0);
 live = true;
 expect(() => factory(authority, cwd).execute({ input: "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch" })).toThrow("revoked");
 expect(deletes).toBe(0);
 expect(fs.readFileSync(join(cwd, "a.txt"), "utf8")).toBe("hello\n");
}));

test("move checks destination write and source unlink independently", () => fixture(cwd => {
 fs.writeFileSync(join(cwd, "a.txt"), "hello\n");
 let live = true, unlinks = 0;
 const files = { ...fs,
  writeFileSync(...args: any[]) { (fs.writeFileSync as any)(...args); live = false; },
  unlinkSync(path) { unlinks++; fs.unlinkSync(path); }
 } as PatchFilePorts;
 const tool = createNativeApplyPatchFactory(files)({ assertCurrent() { if (!live) throw Error("revoked"); } }, cwd);
 expect(() => tool.execute({ input: "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-hello\n+world\n*** End Patch" })).toThrow("revoked");
 expect(unlinks).toBe(0);
 expect(fs.readFileSync(join(cwd, "a.txt"), "utf8")).toBe("hello\n");
 expect(fs.readFileSync(join(cwd, "b.txt"), "utf8")).toBe("world\n");
}));
