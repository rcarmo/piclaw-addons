import { test, expect } from "bun:test";
import { createNativeProcessPool, createNativeExecCommandTool, createNativeWriteStdinTool } from "./src/native-process.ts";
const identity = { chatId: "a", ownerIncarnation: "one", sessionRevision: "r1", cwd: process.cwd(), assertCurrent() {} };
test("two native exports execute and reject foreign handles and disposed identities", async () => {
 const pool = createNativeProcessPool({ minNonInteractiveExecYieldTimeMs: 250, minEmptyWriteYieldTimeMs: 250 });
 try {
 const exec = createNativeExecCommandTool(pool, identity);
 const result = await exec.execute("1", { cmd: "printf ready; sleep 2", shell: "/bin/sh", login: false, yield_time_ms: 250 });
 const id = result.details.session_id!;
 expect(result.details.output).toBe("ready");
 for (const changed of [{ chatId: "b" }, { ownerIncarnation: "two" }, { sessionRevision: "r2" }]) {
 await expect(pool.write({ ...identity, ...changed }, { session_id: id })).rejects.toThrow("Unauthorized");
 }
 const write = createNativeWriteStdinTool(pool, identity);
 expect((await write.execute("2", { session_id: id, yield_time_ms: 250 })).details.session_id).toBe(id);
 pool.disposeIdentity(identity);
 await expect(write.execute("3", { session_id: id })).rejects.toThrow();
 } finally { pool.dispose(); }
 await expect(pool.exec(identity, { cmd: "true" })).rejects.toThrow("Disposed");
});
test("old exec abort loses authority when a new write is admitted", async () => {
 const pool = createNativeProcessPool({ minNonInteractiveExecYieldTimeMs: 250, minEmptyWriteYieldTimeMs: 250 });
 const old = new AbortController();
 try {
 const result = await pool.exec({ ...identity, signal: old.signal }, { cmd: "sleep 1; printf survived", shell: "/bin/sh", login: false, yield_time_ms: 250 });
 const pending = pool.write(identity, { session_id: result.session_id!, yield_time_ms: 1500 });
 old.abort();
 expect((await pending).output).toBe("survived");
 } finally { pool.dispose(); }
});
test("effect guard rechecks after wait and rejects stale output", async () => {
 const pool = createNativeProcessPool({ minNonInteractiveExecYieldTimeMs: 250 });
 let valid = true;
 const pending = pool.exec({ ...identity, assertCurrent() { if (!valid) throw Error("stale"); } }, { cmd: "sleep 1", shell: "/bin/sh", login: false, yield_time_ms: 250 });
 valid = false;
 try { await expect(pending).rejects.toThrow("stale"); } finally { pool.dispose(); }
});
