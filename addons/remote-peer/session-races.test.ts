import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerService } from "./service.js";
import type { Peer } from "./state.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "peer-session-races-"));
  let incarnation = "B1";
  const inputs: any[] = [];
  const messaging: any = {
    listAdvertisableAgents: async () => [{ agent_name: "smith", active: false }],
    listAdvertisableSessions: async () => [
      { chatJid: "web:A", agentName: "smith", incarnation: "A1", active: true },
      { chatJid: "web:B", agentName: "smith", incarnation, active: false },
    ],
    resolveLocalTarget: async (input: any) => input.target_incarnation === incarnation ? { status: "resolved", incarnation, target_agent_name: "smith", active: false } : { status: "not_found" },
    deliverPeerMessage: async (input: any) => {
      input.signal.throwIfAborted();
      if (input.target_incarnation && input.target_incarnation !== incarnation) throw new Error("stale lifetime");
      inputs.push(input); return { row_id: 7 };
    },
  };
  const service = new PeerService({ dataDir: root, runtime: { messaging }, transportFactory: (() => ({ id: "11".repeat(32), clientId: "local", close: async () => {}, start: async () => {}, status: () => ({}), request: async () => ({ body: {} }) })) as any });
  service.state.saveConfig({ ...service.state.config(), enabled: true, mdnsEnabled: false });
  const peer: Peer = { id: "22".repeat(32), alias: "lab", name: "Lab", status: "paired", request: "r", epoch: "e", expires: Date.now() + 60000, ticket: null, scope: "inbox-only", modes: ["queue", "auto", "steer"], agents: [], files: true, lastSeen: null };
  service.state.put(peer);
  const context: any = { version: 1, accessMode: "single-user", kind: "operator", resolveTarget: async (s: any) => s.incarnation === incarnation ? { chatJid: "web:B", agentName: "smith", incarnation, active: false } : null };
  const advertise = async () => {
    await service.advertise("smith", "research", ["queue", "auto", "steer"]);
    await service.sessionAdvertise({ agent: "research", session_alias: "second", chat_jid: "web:B", incarnation, modes: ["queue", "auto", "steer"] }, context);
  };
  const policy = (sessions: any[]) => service.setPolicy(peer.id, { ...peer, sessions, confirmation: "ALLOW REMOTE ACCESS" });
  const grant = () => policy([{ agent: "research", session_alias: "second", revision: (service.state.db.query("SELECT revision FROM advertised_sessions").get() as { revision: string }).revision, modes: ["queue", "auto", "steer"] }]);
  const receive = (target = "@research/second", mode = "queue", files: any[] = [], bytes = new Uint8Array()) => service.receive(peer.id, { op: "message", body: { epoch: "e", messageId: "m", reply: "reply." + "a".repeat(32), semantic: { target, mode, content: "hello", sourceAgent: "remote", sourceDisplay: "Remote", files } } } as any, bytes);
  return { service, peer, root, inputs, messaging, advertise, grant, policy, receive, replace: () => { incarnation = "B2"; }, close: async () => { await service.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("non-first idle B delivers exact lifetime, all reply modes and authenticated attachments", async () => {
  for (const mode of ["queue", "auto", "steer"]) {
    const f = fixture();
    try {
      await f.advertise(); f.grant();
      const bytes = new TextEncoder().encode("file");
      const descriptor = { filename: "note.txt", content_type: "text/plain", size: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
      await f.receive(undefined, mode, [descriptor], bytes);
      expect(f.inputs[0]).toMatchObject({ target_chat_jid: "web:B", target_incarnation: "B1", mode, source: { peer_instance_id: f.peer.id, peer_alias: "lab", agent_name: "remote", agent_display_name: "Remote", reply_address: "lab!reply." + "a".repeat(32) } });
      expect(f.inputs[0].attachments[0].data).toEqual(bytes);
      expect(f.inputs[0].target_agent_name).toBeUndefined();
    } finally { await f.close(); }
  }
});

test("stale replacement cannot deliver and re-advertisement requires new grant", async () => {
  const f = fixture();
  try {
    await f.advertise(); f.grant(); f.replace();
    await expect(f.receive()).rejects.toThrow("stale");
    expect(f.inputs).toEqual([]);
    await f.advertise();
    await expect(f.receive()).rejects.toThrow("Session access denied");
    f.grant(); await f.receive();
    expect(f.inputs[0].target_incarnation).toBe("B2");
  } finally { await f.close(); }
});

for (const race of ["deny", "regrant", "revoke", "configure", "replace"] as const) {
  test(`session admission revalidates ${race} after async target resolution`, async () => {
    const f = fixture(); const entered = deferred(), resume = deferred();
    try {
      await f.advertise(); f.grant();
      const resolve = f.messaging.resolveLocalTarget;
      f.messaging.resolveLocalTarget = async (input: any) => { const result = await resolve(input); entered.resolve(); await resume.promise; return result; };
      const pending = f.receive().then(() => null, (error) => error);
      await entered.promise;
      if (race === "deny" || race === "regrant") { f.policy([]); if (race === "regrant") f.grant(); }
      if (race === "revoke") await f.service.revoke(f.peer.id, f.peer.id);
      if (race === "configure") await f.service.configure({ enabled: false });
      if (race === "replace") { f.replace(); await f.advertise(); f.grant(); }
      resume.resolve(); expect(await pending).toBeInstanceOf(Error);
      expect(f.inputs).toEqual([]);
      expect(f.service.state.db.query("SELECT * FROM inbound").all()).toEqual([]);
    } finally { resume.resolve(); await f.close(); }
  });
}

for (const race of ["deny", "regrant", "revoke", "configure", "unadvertise", "close"] as const) {
  test(`in-flight core admission signal cancels on ${race}`, async () => {
    const f = fixture(); const entered = deferred(), resume = deferred();
    try {
      await f.advertise(); f.grant();
      const deliver = f.messaging.deliverPeerMessage;
      f.messaging.deliverPeerMessage = async (input: any) => { entered.resolve(); await resume.promise; return deliver(input); };
      const pending = f.receive().then(() => null, (error) => error);
      await entered.promise;
      if (race === "deny" || race === "regrant") { f.policy([]); if (race === "regrant") f.grant(); }
      if (race === "revoke") await f.service.revoke(f.peer.id, f.peer.id);
      if (race === "configure") await f.service.configure({ enabled: false });
      if (race === "unadvertise") f.service.unadvertise("research");
      if (race === "close") await f.service.close();
      resume.resolve(); expect(await pending).toBeInstanceOf(Error);
      expect(f.inputs).toEqual([]);
    } finally { resume.resolve(); await f.close(); }
  });
}

test("legacy reply capability preserves exact source branch instead of first agent branch", async () => {
  const f = fixture();
  try {
    f.service.state.db.query("INSERT INTO replies VALUES (?,?,?,?,?)").run("token", f.peer.id, "e", "web:B", Date.now() + 60000);
    await f.receive("reply.token", "steer");
    expect(f.inputs[0]).toMatchObject({ target_chat_jid: "web:B", mode: "steer" });
    expect(f.inputs[0].target_agent_name).toBeUndefined();
  } finally { await f.close(); }
});
