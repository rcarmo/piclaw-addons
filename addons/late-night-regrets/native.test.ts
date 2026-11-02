import { test, expect } from "bun:test";
import { createLateNightRegrets, type RegretsNativePorts } from "./native.js";
function fixture(patch: Partial<RegretsNativePorts> = {}) {
  let current = true;
  const ports: RegretsNativePorts = {
    chat: "fixture", cwd: "/fixture", assertCurrent() { if (!current) throw Error("revoked"); },
    assertSingleUser() {}, config: { get: () => ({ review_scope: "current" }), set() {} },
    history: async () => ({ exchanges: [], excluded: {} }), readFile: async () => undefined,
    accountedDecision: { getAvailable: () => [], complete: async () => { throw Error("No fixture model"); } },
    admitConversationInput: async text => ({ admitted: text }), ...patch,
  };
  return { native: createLateNightRegrets(ports), revoke() { current = false; } };
}
test("native review uses fixture ports and preserves disabled decision", async () => {
  const { native } = fixture();
  const result = await native.tool.execute("id", {});
  expect(result.details).toHaveProperty("decision.status", "disabled");
  expect(native.resources.skillPaths.length).toBe(1);
  expect(await native.command()).toHaveProperty("admitted");
});
test("disabled does not access history or admit input", async () => {
  const { native } = fixture({ config: { get: () => ({ enabled: false }), set() {} }, history: async () => { throw Error("history forbidden"); }, admitConversationInput: async () => { throw Error("admission forbidden"); } });
  expect((await native.tool.execute("id", {})).details).toEqual({ disabled: true });
  expect(await native.command()).toEqual({ disabled: true });
  expect(native.prompt("base")).toBe("base");
});
test("revocation after awaited history stops file access", async () => {
  const f = fixture({ history: async () => { f.revoke(); return { exchanges: [], excluded: {} }; }, readFile: async () => { throw Error("file accessed"); } });
  await expect(f.native.tool.execute("id", {})).rejects.toThrow("revoked");
});
test("single user denial and path escape fail closed", async () => {
  const { native } = fixture({ assertSingleUser() { throw Error("single user required"); } });
  await expect(native.tool.execute("id", {})).rejects.toThrow("single user");
  await expect(native.setConfig({ exports_dir: "../outside" })).rejects.toThrow("escapes");
});

test('an unavailable saved decision model cannot block disabling or unrelated native settings', async () => {
  let config = { enabled: true, decision_model: 'fixture/removed' };
  let catalogues = 0, writes = 0;
  const f = fixture({ config: { get: () => config, set(value) { writes++; config = value; } },
    accountedDecision: { getAvailable() { catalogues++; return []; }, async complete() { throw Error('Settings must not execute'); } },
  });
  await f.native.setConfig({ enabled: false });
  expect(config).toMatchObject({ enabled: false, decision_model: 'fixture/removed' });
  await f.native.setConfig({ reflections_path: 'notes/changed.md' });
  expect([writes, catalogues]).toEqual([2, 0]);
  await expect(f.native.setConfig({ decision_model: 'fixture/another-removed' })).rejects.toThrow('available');
  expect([writes, catalogues]).toEqual([2, 1]);
});
