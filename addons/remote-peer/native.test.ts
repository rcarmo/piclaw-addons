import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemotePeerAuthorityScope } from "./native-authority.js";
import { bindNativeRemotePeer, createRemotePeerTool } from "./native.js";
import { remotePeerParameters } from "./actions.js";

test("work-result delivery waits for asynchronous host admission before acknowledging its row", async () => {
  const directory = mkdtempSync(join(tmpdir(), "remote-peer-admission-"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const target = { domain: "fixture", chatJid: "web:fixture", branchId: "main", conversationId: 1, sessionId: "session", revision: "r1" };
  let admissions = 0, acknowledged = false;
  const bound = await bindNativeRemotePeer({ dataDir: directory, nativeRootServiceOwner: { assertCurrent() {} },
    transportFactory: () => ({ async close() {}, status() { return { active: false }; } }) as any,
    bundle: { sessionTargets: { list: () => [target], resolve: () => target },
      async admitApplicationInput() { admissions++; await gate; return { rowId: 42, chatJid: target.chatJid }; } },
  });
  const policy = spyOn(bound.service, "assertNativePeerCurrent").mockImplementation(() => {});
  const pending = bound.authority.incoming({ peer: "fixture-peer", revision: "epoch", operation: "work-result" },
    () => (bound.service as any).options.runtime.enqueueAgentMessage({ mode: "queue", chatJid: target.chatJid, content: "synthetic result" }))
    .then(result => { acknowledged = true; return result; });
  try {
    await Bun.sleep(0);
    expect(acknowledged).toBe(false);
    release();
    expect(await pending).toMatchObject({ status: "ok", row_id: 42, chat_jid: target.chatJid });
    expect(admissions).toBe(1);
  } finally { release(); await pending.catch(() => {}); policy.mockRestore(); await bound.authority.application("close", () => bound.service.close()); rmSync(directory, { recursive: true, force: true }); }
});

function fixture() {
  let current = { chat: "chat-a", incarnation: "inc-a", revoked: false };
  const accepted = (chatJid = "chat-a", incarnation = "inc-a") => ({ chatJid, cwd: "/owned-fixture",
    assertCurrent() { if (current.revoked || current.chat !== chatJid || current.incarnation !== incarnation) throw Error("stale authority"); } });
  let admissions = 0;
  const scope = new RemotePeerAuthorityScope({ async acceptOperation(_source, body) {
    admissions++; return body(accepted(current.chat, current.incarnation));
  } });
  return { scope, accepted, set: (value: typeof current) => { current = value; }, admissions: () => admissions };
}

test("native dispatch preserves every declared action using only owned fake service", async () => {
  const f = fixture();
  const calls: string[] = [];
  const fake = new Proxy({ transport: { ticket: () => "fake-ticket" } }, { get(target, name) {
    if (name === "transport") return target.transport;
    return (..._args: unknown[]) => { f.scope.assertCurrent(); calls.push(String(name)); return { fake: true }; };
  } });
  const tool = createRemotePeerTool({ ...f.accepted(), nativeHostPorts: { authority: f.scope,
    service: fake as any, localContext: () => ({ version: 1, accessMode: "single-user", kind: "operator", listTargets: async () => [], resolveTarget: async () => null }) } });
  for (const action of remotePeerParameters.properties.action.enum) await tool.execute("owned", { action });
  for (const method of ["dashboard", "identity", "start", "pair", "accept", "deny", "revoke", "forget", "rotateIdentity", "setAlias", "setPolicy", "remotePermissions", "advertise", "unadvertise", "localSessions", "sessionAdvertise", "sessionUnadvertise", "ping", "retry", "workSend", "reviewWork"]) expect(calls).toContain(method);
});

for (const changed of [
  { chat: "chat-a", incarnation: "inc-a", revoked: true },
  { chat: "chat-b", incarnation: "inc-a", revoked: false },
  { chat: "chat-a", incarnation: "inc-b", revoked: false },
]) test(`inner checks reject ${JSON.stringify(changed)} after await before effects`, async () => {
  const f = fixture(); let effects = 0;
  const dependency = f.scope.guard({ async wait() { await Promise.resolve(); f.set(changed); },
    network() { effects++; }, resolveTarget() { effects++; }, queue() { effects++; }, steer() { effects++; },
    db: { query() { return { run() { effects++; } }; } } });
  await f.scope.run(f.accepted(), async () => {
    const statement = dependency.db.query();
    await dependency.wait();
    for (const effect of [() => dependency.network(), () => dependency.resolveTarget(), () => dependency.queue(), () => dependency.steer(), () => statement.run()]) expect(effect).toThrow("stale");
  });
  expect(effects).toBe(0);
});

test("ingress accepts a fresh operation and never inherits an expired tool scope", async () => {
  const f = fixture();
  await f.scope.run(f.accepted(), async () => {
    f.set({ chat: "chat-b", incarnation: "inc-b", revoked: false });
    expect(f.scope.assertCurrent).toThrow();
    await f.scope.incoming({ peer: "fake", revision: "epoch-1", operation: "message" }, async () => { f.scope.assertCurrent(); });
    expect(f.scope.assertCurrent).toThrow();
  });
  expect(f.admissions()).toBe(1);
  expect(f.scope.assertCurrent).toThrow("accepted operation required");
});

test("actual transport write rechecks authority between network writes", async () => {
  const { IrohTransport } = await import("./transport.js");
  const f = fixture(); let writes = 0;
  // No constructor, endpoint, pairing, secret key or network is involved.
  const transport = Object.create(IrohTransport.prototype) as any;
  transport.options = { assertCurrent: f.scope.assertCurrent };
  const stream = { async writeAll() { writes++; f.set({ chat: "chat-a", incarnation: "inc-a", revoked: true }); }, async finish() { throw Error("must not finish"); } };
  await expect(f.scope.run(f.accepted(), () => transport.write(stream, { op: "fixture" }, new Uint8Array()))).rejects.toThrow("stale");
  expect(writes).toBe(1);
});

test("concurrent invocation scopes do not swap authority", async () => {
  const f = fixture();
  let resume!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const first = f.scope.run(f.accepted(), async () => { await paused; f.scope.assertCurrent(); });
  expect(() => f.scope.run({ chatJid: "other", cwd: "/other", assertCurrent() { throw Error("wrong session"); } }, () => {})).toThrow("wrong session");
  resume(); await first;
});

 test("verified ingress resolves real policy before accepting authority", async () => {
  const { PeerService } = await import("./service.js");
  const service = Object.create(PeerService.prototype) as any;
  let epoch = "revision-1";
  const sources: unknown[] = [];
  service.authorizationState = { config: () => ({ enabled: true }), peer: (id: string) =>
    id === "actual-peer" ? { status: "paired", epoch } : null };
  service.options = { authority: new RemotePeerAuthorityScope({ async acceptOperation(source, body) {
    sources.push(source);
    return body({ chatJid: "root-target", cwd: "/owned-fixture", assertCurrent() {} });
  } }) };
  service.receive = async () => { service.options.authority.assertCurrent(); return { body: { ok: true } }; };
  for (const [peer, revision] of [["wrong-peer", epoch], ["actual-peer", "old-revision"]])
    await expect(service.authenticatedIngress(peer, { op: "message", body: { epoch: revision } }, new Uint8Array())).rejects.toThrow();
  expect(sources).toEqual([]);
  await service.authenticatedIngress("actual-peer", { op: "message", body: { epoch } }, new Uint8Array());
  expect(sources).toEqual([{ kind: "incoming", peer: "actual-peer", revision: epoch, operation: "message" }]);
 });


test("native application lifetime needs no invented operation and binds only verified ingress", async () => {
  let retired = false;
  const scope = new RemotePeerAuthorityScope({ assertCurrent() { if (retired) throw Error("owner retired"); } });
  await scope.application("start", async () => {
    scope.assertCurrent();
    expect(() => scope.verifiedPeer()).toThrow("Authenticated peer required");
  });
  await scope.incoming({ peer: "verified-key", revision: "epoch-2", operation: "message" }, async () => {
    expect(scope.verifiedPeer()).toEqual({ peer: "verified-key", revision: "epoch-2", operation: "message" });
    await Promise.resolve(); retired = true;
    expect(scope.assertCurrent).toThrow("owner retired");
  });
  expect(() => scope.verifiedPeer()).toThrow();
  expect(() => scope.application("start", async () => {})).toThrow("owner retired");
});
