import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PeerService } from "./service.js";
import { IrohTransport } from "./transport.js";

// Test-only cross-worktree imports, deliberately dynamic: never a production dependency.
// Explicit test fixture only; production add-ons never import core sources.
const coreRoot = process.env.PICLAW_REMOTE_SESSION_CORE_ROOT;
const core = coreRoot ? resolve(coreRoot, "runtime/src") + "/" : "";
const workerRoot = process.env.REMOTE_SESSION_165_FIXTURE;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

async function worker(root: string) {
  const load = (path: string) => import(core + path);
  const db = await load("db/connection.ts");
  const { ensureChatBranch } = await load("db/chat-branches.ts");
  const { createAddonMessagingRuntimeHandlers } = await load("addons/runtime-messaging.ts");
  const { WebChannelRuntimePublicSurfaceService } = await load("channels/web/core/web-channel-runtime-public-surface-service.ts");
  const { readInputRequestAuthority } = await load("channels/web/messaging/input-request-authority.ts");
  const { admitWebUserMessage } = await load("channels/web/messaging/message-store.ts");
  const { QueuedFollowupLifecycleService } = await load("channels/web/runtime/queued-followup-lifecycle-service.ts");
  db.initDatabase();
  // Two agents, each with two persisted idle branches; first-agent fallback is wrong.
  const branches = ["research", "auditor"].flatMap(agent => ["first", "second"].map(alias =>
    ensureChatBranch({ chat_jid: `web:${agent}:${alias}`, root_chat_jid: `web:${agent}:first`, agent_name: agent })));
  const target = branches[1];
  const queue = new QueuedFollowupLifecycleService();
  let held: ReturnType<typeof deferred> | null = null;
  let entered = deferred();
  let mutateAfter = false;
  const host = new WebChannelRuntimePublicSurfaceService({
    handleAgentMessage: async (req: Request) => {
      const body = await req.json() as any;
      const jid = new URL(req.url).searchParams.get("chat_jid")!;
      const authority = readInputRequestAuthority(req, jid, "/agent/default/message")!;
      if (held) { const gate = held; entered.resolve(); await gate.promise; }
      const validate = (phase?: "before" | "after") => {
        if (phase === "after" && mutateAfter) {
          mutateAfter = false;
          db.getDb().query("UPDATE chat_branches SET branch_id=? WHERE chat_jid=?").run("replaced-inside-transaction", jid);
        }
        authority.validate(phase);
      };
      if (body.mode === "queue") {
        await queue.admitQueuedFollowupItem([jid, 0, body.content, body.thread_id, undefined,
          { contentBlocks: body.content_blocks, source: body.source, queuedBy: body.queued_by }], validate, req.signal);
        return Response.json({ status: "ok", chat_jid: jid, queued: "followup" });
      }
      const row = await admitWebUserMessage({ broadcastEvent() {} },
        { chatJid: jid, content: body.content, isBot: false, mediaIds: body.media_ids ?? [], agentId: "default", agentName: "Fixture" },
        { contentBlocks: body.content_blocks, threadId: body.thread_id }, validate, req.signal);
      return Response.json({ status: "ok", chat_jid: jid, user_message: row });
    },
  } as any);
  const messaging = createAddonMessagingRuntimeHandlers({
    listKnownChats: () => db.getDb().query("SELECT * FROM chat_branches ORDER BY rowid").all().map((b: any) => ({ ...b, is_active: false })),
    findChatByAgentName: (name: string) => branches.find(b => b.agent_name === name) ?? null,
    enqueueAgentMessage: (request: any) => host.enqueueAgentMessage(request),
  });
  const service = new PeerService({ dataDir: join(root, "peer"), runtime: { messaging } as any, bindAddr: "127.0.0.1:0" });
  // Explicit synthetic bound operator only for advertisement; targets come from core DB.
  const context: any = { version: 1, accessMode: "single-user", kind: "operator",
    listTargets: () => messaging.listAdvertisableSessions(),
    resolveTarget: (s: any) => messaging.listAdvertisableSessions().find((t: any) => t.chatJid === s.chatJid && t.incarnation === s.incarnation) ?? null };
  const advertise = async () => {
    await service.advertise(target.agent_name, "research", ["auto", "queue"]);
    const t = messaging.listAdvertisableSessions().find((t: any) => t.chatJid === target.chat_jid)!;
    await service.sessionAdvertise({ agent: "research", session_alias: "second", chat_jid: t.chatJid, incarnation: t.incarnation, modes: ["auto", "queue"] }, context);
  };
  const actions: Record<string, (arg: any) => any> = {
    identity: () => ({ ...service.identity(), ticket: service.transport.ticket(), native: service.transport instanceof IrohTransport, status: service.transport.status(), branches, sessions: messaging.listAdvertisableSessions(), pid: process.pid }),
    pair: arg => service.pair(arg), accept: arg => service.accept(arg.id, arg.clientId),
    advertise,
    grant: arg => {
      const row: any = service.state.db.query("SELECT revision FROM advertised_sessions WHERE agent='research' AND session_alias='second'").get();
      return service.setPolicy(arg.id, { scope: "inbox-only", modes: ["auto", "queue"], agents: [], files: false,
        sessions: [{ agent: "research", session_alias: "second", revision: row.revision, modes: ["auto", "queue"] }], confirmation: "ALLOW REMOTE ACCESS" });
    },
    directory: () => service.directory(), send: arg => service.send(arg),
    resolve: arg => messaging.resolveLocalTarget(arg),
    hold: () => { held = deferred(); entered = deferred(); }, entered: () => entered.promise,
    resume: () => { held?.resolve(); held = null; },
    replace: () => db.getDb().query("UPDATE chat_branches SET branch_id=? WHERE chat_jid=?").run(crypto.randomUUID(), target.chat_jid),
    mutateAfter: () => { mutateAfter = true; },
    revoke: arg => service.revoke(arg.id, arg.clientId),
    snapshot: () => ({ messages: db.getDb().query("SELECT * FROM messages ORDER BY rowid").all(),
      inbound: service.state.db.query("SELECT * FROM inbound WHERE receipt IS NOT NULL OR status='queued'").all(),
      uncommittedInbound: service.state.db.query("SELECT * FROM inbound WHERE receipt IS NULL AND status!='queued'").all(),
      queued: branches.map(b => ({ jid: b.chat_jid, count: queue.getQueuedFollowupCount(b.chat_jid) })),
      sessions: messaging.listAdvertisableSessions() }),
    close: async () => { held?.resolve(); await service.close(); db.closeDatabase(); },
  };
  await service.configure({ enabled: true, instanceName: "Disposable session fixture", relayMode: "disabled", addressLookup: false, mdnsEnabled: false });
  process.on("message", async (message: any) => {
    try { const value = await actions[message.action](message.arg); process.send!({ id: message.id, value }); }
    catch (error) { process.send!({ id: message.id, error: String(error) }); }
  });
  process.send!({ ready: true });
}

function launch(root: string) {
  mkdirSync(root, { recursive: true });
  let serial = 0;
  const ready = deferred();
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const child = Bun.spawn([process.execPath, import.meta.path], {
    env: { PATH: process.env.PATH!, HOME: root, NODE_ENV: "test", REMOTE_SESSION_165_FIXTURE: root,
      PICLAW_REMOTE_SESSION_CORE_ROOT: coreRoot!,
      PICLAW_WORKSPACE: root, PICLAW_STORE: join(root, "store"), PICLAW_DATA: join(root, "data"), PICLAW_DB_IN_MEMORY: "1" },
    stdout: "ignore", stderr: "inherit",
    ipc(message: any) {
      if (message.ready) { ready.resolve(); return; }
      const p = pending.get(message.id); pending.delete(message.id);
      if (message.error) p?.reject(new Error(message.error)); else p?.resolve(message.value);
    },
  });
  const call = (action: string, arg?: any): Promise<any> => new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, { resolve, reject }); child.send({ id, action, arg });
  });
  const startup = Promise.race([ready.promise, child.exited.then(code => { throw Error(`fixture exited before ready: ${code}`); }),
    Bun.sleep(15000).then(() => { throw Error("fixture startup timed out"); })]);
  return { call, ready: startup, close: async () => { try { await Promise.race([call("close"), Bun.sleep(5000)]); } finally { child.kill(); await child.exited; } } };
}

if (workerRoot) {
  await worker(workerRoot);
} else {
  (coreRoot ? test : test.skip)("two native loopback PeerServices admit exact second DB branch, reply, and fail closed across lifetime/revoke races", async () => {
    const root = mkdtempSync(join(tmpdir(), "remote-session-165-integrated-"));
    const a = launch(join(root, "a")), b = launch(join(root, "b"));
    try {
      await Promise.all([a.ready, b.ready]);
      const ai = await a.call("identity"), bi = await b.call("identity");
      expect(ai.pid).not.toBe(bi.pid);
      for (const identity of [ai, bi]) {
        expect(identity.native).toBe(true);
        expect(identity.status.relay).toBeNull();
        expect(identity.branches).toHaveLength(4);
        expect(identity.sessions).toHaveLength(4);
        expect(identity.sessions.every((s: any) => !s.active && s.incarnation)).toBe(true);
      }
      for (const [instance, identity] of [[a, ai], [b, bi]] as const) {
        for (const branch of identity.branches) {
          expect(await instance.call("resolve", { target_chat_jid: branch.chat_jid, target_incarnation: branch.branch_id }))
            .toMatchObject({ status: "resolved", incarnation: branch.branch_id, active: false });
        }
      }
      await a.call("pair", { clientId: bi.clientId, alias: "beta", ticket: bi.ticket });
      await b.call("accept", { id: ai.endpointId, clientId: ai.clientId });
      await Promise.all([a.call("advertise"), b.call("advertise")]);
      await a.call("grant", { id: bi.endpointId });
      await b.call("grant", { id: ai.endpointId });
      const directory = await a.call("directory");
      expect(directory.entries.find((e: any) => e.address === "beta!@research/second")).toMatchObject({ target_kind: "session" });
      expect(JSON.stringify(directory)).not.toContain(bi.branches[1].branch_id);
      expect(JSON.stringify(directory)).not.toContain(bi.branches[1].chat_jid);
      const request = (key: string) => ({ source_chat_jid: ai.branches[1].chat_jid, source_agent_name: "research",
        address: { kind: "bang", raw: "beta!@research/second", peer: "beta", target: "@research/second" },
        content: key, mode: "auto", idempotency_key: key });
      await a.call("send", request("exact-second"));
      let bs = await b.call("snapshot");
      expect(bs.messages).toHaveLength(1);
      expect(bs.messages[0].chat_jid).toBe(bi.branches[1].chat_jid);
      const blocks = typeof bs.messages[0].content_blocks === "string" ? JSON.parse(bs.messages[0].content_blocks) : bs.messages[0].content_blocks;
      const provenance = blocks.find((x: any) => x.type === "peer_message");
      expect(provenance.target_chat_jid).toBe(bi.branches[1].chat_jid);
      const address = provenance.reply_to.address;
      const [peer, target] = address.split("!");
      await b.call("send", { source_chat_jid: bi.branches[1].chat_jid, address: { kind: "bang", raw: address, peer, target }, content: "exact-reply", mode: "auto" });
      const as = await a.call("snapshot");
      expect(as.messages).toHaveLength(1);
      expect(as.messages[0].chat_jid).toBe(ai.branches[1].chat_jid);
      // After-mutation authority check runs inside real SQLite transaction: no timeline/inbound commit.
      await b.call("mutateAfter");
      await expect(a.call("send", request("transaction-rollback"))).rejects.toThrow("lifetime changed");
      bs = await b.call("snapshot");
      expect(bs.messages).toHaveLength(1); expect(bs.inbound).toHaveLength(1);
      // Current production retains a delivering/NULL-receipt row on host rejection.
      // It is NOT a committed receipt; do not disguise this as zero inbound rows.
      expect(bs.uncommittedInbound).toHaveLength(1);
      expect(bs.uncommittedInbound[0]).toMatchObject({ status: "delivering", receipt: null });
      expect(bs.sessions.find((s: any) => s.chatJid === bi.branches[1].chat_jid).incarnation).toBe(bi.branches[1].branch_id);
      // Replacement during host await invalidates the old selected incarnation.
      await b.call("hold");
      const replacement = a.call("send", request("replacement-race")).catch(e => e);
      await b.call("entered"); await b.call("replace"); await b.call("resume");
      expect(String(await replacement)).toContain("lifetime changed");
      await expect(a.call("send", request("old-target"))).rejects.toThrow("stale");
      bs = await b.call("snapshot"); expect(bs.messages).toHaveLength(1); expect(bs.inbound).toHaveLength(1);
      await b.call("advertise");
      await expect(a.call("send", request("replacement-needs-consent"))).rejects.toThrow();
      await b.call("grant", { id: ai.endpointId });
      await b.call("hold");
      const revoked = a.call("send", request("revoke-race")).catch(e => e);
      await b.call("entered");
      await b.call("revoke", { id: ai.endpointId, clientId: ai.clientId });
      await b.call("resume"); expect(await revoked).toBeInstanceOf(Error);
      bs = await b.call("snapshot"); expect(bs.messages).toHaveLength(1); expect(bs.inbound).toHaveLength(1);
      expect(bs.queued.every((q: any) => q.count === 0)).toBe(true);
    } finally { await Promise.all([a.close(), b.close()]); rmSync(root, { recursive: true, force: true }); }
  }, 60000);
}
