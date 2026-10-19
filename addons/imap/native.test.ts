import { test, expect } from "bun:test";
import { ImapPool, createImapTool } from "./index.ts";
import { ImapClient } from "./imap-client.ts";
const account = { host: "synthetic.invalid", port: 993, tls: true, user: "fixture", pass: "fixture", from: "fixture", name: "fixture", allowSend: false };
for (const stage of ["connect", "login"] as const) test(`revocation after ${stage} disposes without reuse`, async () => {
  let current = true; const calls: string[] = [];
  const pool = new ImapPool(() => ({
    async connect() { calls.push("connect"); if (stage === "connect") current = false; },
    async login() { calls.push("login"); current = false; },
    dispose() { calls.push("dispose"); },
  }) as unknown as ImapClient);
  await expect(pool.acquire(account, () => { if (!current) throw Error("revoked"); })).rejects.toThrow("revoked");
  expect(calls).toEqual(stage === "connect" ? ["connect", "dispose"] : ["connect", "login", "dispose"]);
  pool.dispose();
});
test("explicit disposal closes active client and rejects acquisition", async () => {
  let closed = 0;
  const pool = new ImapPool(() => ({ async connect() {}, async login() {}, dispose() { closed++; } }) as unknown as ImapClient);
  await pool.acquire(account, () => {}); pool.dispose(); pool.dispose();
  expect(closed).toBe(1);
  await expect(pool.acquire(account, () => {})).rejects.toThrow("disposed");
});
test("aborted native invocation performs no account or network access", async () => {
  const controller = new AbortController(); controller.abort();
  const tool = createImapTool({ assertCurrent() {}, chatJid: "fixture", signal: controller.signal });
  await expect(tool.execute("fixture", { action: "list_accounts" })).rejects.toThrow("aborted");
});
test("actual command fence blocks wire write", async () => {
  let writes = 0;
  const client = new ImapClient(account, () => { throw Error("revoked"); });
  (client as any).sock = { write() { writes++; }, destroy() {} };
  await expect(client.noop()).rejects.toThrow("revoked");
  expect(writes).toBe(0); client.dispose();
});

test("queued mutation rechecks authority after previous command", async () => {
  let current = true; const writes: string[] = [];
  const client = new ImapClient(account, () => { if (!current) throw Error("revoked"); });
  (client as any).sock = { write(value: string) { writes.push(value); }, destroy() {} };
  const first = client.noop();
  const second = client.delete("Fixture");
  const checked = Promise.allSettled([first, second]);
  current = false;
  (client as any).feed(Buffer.from("A0001 OK done\r\n"));
  const outcomes = await checked;
  for (const outcome of outcomes) { expect(outcome.status).toBe("rejected"); if (outcome.status === "rejected") expect(outcome.reason.message).toContain("revoked"); }
  expect(writes.length).toBe(1); client.dispose();
});
test("APPEND continuation is fenced after revocation", async () => {
  let current = true; const writes: unknown[] = [];
  const client = new ImapClient(account, () => { if (!current) throw Error("revoked"); });
  (client as any).sock = { write(value: unknown) { writes.push(value); }, destroy() {} };
  const pending = client.append("Fixture", "fixture");
  current = false; (client as any).feed(Buffer.from("+ continue\r\n"));
  await expect(pending).rejects.toThrow("disposed"); expect(writes.length).toBe(1);
});
test("disposal rejects greeting wait immediately and prevents reconnect", async () => {
  const { EventEmitter } = await import("node:events");
  const client = new ImapClient(account);
  const socket = Object.assign(new EventEmitter(), { destroy() {} });
  (client as any).sock = socket;
  const greeting = (client as any).awaitGreeting(); client.dispose();
  await expect(greeting).rejects.toThrow("disposed");
  expect(socket.listenerCount("data")).toBe(0);
  await expect(client.connect()).rejects.toThrow("disposed");
});

for (const method of ["login", "select", "create", "delete", "search", "fetch", "store", "copy", "move", "append"] as const) test(`inner ${method} fence blocks wire effect`, async () => {
  let writes = 0;
  const client = new ImapClient(account, () => { throw Error("revoked"); });
  (client as any).sock = { write() { writes++; }, destroy() {} };
  await expect((client[method] as Function).apply(client, method === "append" ? ["Fixture", "body"] : ["1", "Fixture", []])).rejects.toThrow("revoked");
  expect(writes).toBe(0); client.dispose();
});
test("fresh lease never reuses prior invocation client", async () => {
  let created = 0, disposed = 0;
  const pool = new ImapPool(() => { created++; return { async connect() {}, async login() {}, dispose() { disposed++; } } as unknown as ImapClient; });
  const first = await pool.acquire(account, () => {}); pool.release(first);
  const second = await pool.acquire(account, () => {});
  expect(first).not.toBe(second); expect(created).toBe(2);
  pool.release(second); expect(disposed).toBe(2); pool.dispose();
});

test("connect checks authority even when a socket already exists", async () => {
  const client = new ImapClient(account, () => { throw Error("revoked"); });
  (client as any).sock = { destroy() {} };
  await expect(client.connect()).rejects.toThrow("revoked"); client.dispose();
});
test("MOVE fallback cannot STORE after COPY revocation", async () => {
  let current = true; const writes: string[] = [];
  const client = new ImapClient(account, () => { if (!current) throw Error("revoked"); });
  (client as any).sock = { write(value: string) { writes.push(value); }, destroy() {} };
  const pending = client.move("1", "Fixture");
  current = false; (client as any).feed(Buffer.from("A0001 OK copied\r\n"));
  await expect(pending).rejects.toThrow("revoked");
  expect(writes.length).toBe(1); expect(writes[0]).toContain("COPY"); client.dispose();
});
