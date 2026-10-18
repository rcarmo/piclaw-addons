import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import drawioEditor from "./index";
import { createDrawioEditorTool } from "./tool";

const roots: string[] = [];
function workspace() { const root = mkdtempSync(join(tmpdir(), "drawio-ports-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("shared factory preserves legacy tab request, existing bytes and fallback", async () => {
  const root = workspace();
  let registered: ReturnType<typeof createDrawioEditorTool> | undefined;
  drawioEditor({ registerTool(tool: ReturnType<typeof createDrawioEditorTool>) { registered = tool; } });
  expect(registered?.execute.toString()).toBe(createDrawioEditorTool().execute.toString());
  const previous = process.env.PICLAW_WORKSPACE;
  process.env.PICLAW_WORKSPACE = root;
  try {
    const requests: unknown[] = [];
    const ctx = { hasUI: true, ui: { custom(_component: unknown, request: unknown) { requests.push(request); return { ok: true, opened: true }; } } };
    const first = await registered!.execute("call", { path: "diagrams/new.drawio" }, undefined, undefined, ctx);
    expect(first.details).toMatchObject({ ok: true, target: "tab" });
    expect(requests).toEqual([{ timeout: 15000, action: "open_workspace_file", path: "diagrams/new.drawio", label: "new.drawio", target: "tab" }]);
    writeFileSync(join(root, "diagrams/new.drawio"), "user document");
    const native = createDrawioEditorTool({ cwd: root, authority: { assertCurrent() {}, openWorkspaceFile() { return { ok: false, opened: false, reason: "not_supported" }; } } });
    const fallback = await native.execute("call", { path: "diagrams/new.drawio" });
    expect(readFileSync(join(root, "diagrams/new.drawio"), "utf8")).toBe("user document");
    expect(fallback.details).toMatchObject({ reason: "not_supported", editorUrl: "/drawio/edit?path=diagrams%2Fnew.drawio" });
    expect(fallback.content[0]!.text).toContain("Fallback URL");
  } finally { if (previous === undefined) delete process.env.PICLAW_WORKSPACE; else process.env.PICLAW_WORKSPACE = previous; }
});

test("guards every creation stage and rejects closest-parent symlink escapes", async () => {
  const root = workspace(), outside = workspace();
  symlinkSync(outside, join(root, "escape"));
  const tool = createDrawioEditorTool({ cwd: root, authority: { assertCurrent() {} } });
  await expect(tool.execute("call", { path: "escape/missing/new.drawio" })).rejects.toThrow("Forbidden path");
  expect(existsSync(join(outside, "missing"))).toBe(false);
  await expect(tool.execute("call", { path: "../outside.drawio" })).rejects.toThrow("Forbidden path");
  let calls = 0;
  const revoked = createDrawioEditorTool({ cwd: root, authority: { assertCurrent() { if (++calls === 3) throw Error("revoked"); } } });
  await expect(revoked.execute("call", { path: "one/two/new.drawio" })).rejects.toThrow("revoked");
  expect(existsSync(join(root, "one"))).toBe(true);
  expect(existsSync(join(root, "one/two"))).toBe(false);
});

test("exclusive create does not overwrite a racing document; post-UI revocation rejects", async () => {
  const root = workspace();
  let checks = 0;
  const racer = createDrawioEditorTool({ cwd: root, authority: { assertCurrent() { if (++checks === 2) writeFileSync(join(root, "race.drawio"), "race winner"); } } });
  await racer.execute("call", { path: "race.drawio" });
  expect(readFileSync(join(root, "race.drawio"), "utf8")).toBe("race winner");
  let current = true;
  const revoked = createDrawioEditorTool({ cwd: root, authority: {
    assertCurrent() { if (!current) throw Error("revoked after UI"); },
    async openWorkspaceFile() { current = false; return { ok: true, opened: true }; },
  } });
  await expect(revoked.execute("call", { path: "race.drawio" })).rejects.toThrow("revoked after UI");
});

test("factory captures original authority methods and preserves their receiver", async () => {
  const root = workspace();
  let active = true, opens = 0;
  const authority = {
    marker: "original",
    assertCurrent() { if (!active) throw Error("original grant revoked"); },
    openWorkspaceFile() { expect(this.marker).toBe("original"); opens++; return { ok: true, opened: true }; },
  };
  const options = { cwd: root, authority };
  const tool = createDrawioEditorTool(options);
  authority.openWorkspaceFile = () => { throw Error("replacement opener must not run"); };
  await tool.execute("call", { path: "capture.drawio" });
  expect(opens).toBe(1);
  active = false;
  authority.assertCurrent = () => {};
  options.authority = { marker: "replacement", assertCurrent() {}, openWorkspaceFile() { throw Error("replacement grant must not run"); } };
  await expect(tool.execute("call", { path: "denied.drawio" })).rejects.toThrow("original grant revoked");
  expect(existsSync(join(root, "denied.drawio"))).toBe(false);
});
