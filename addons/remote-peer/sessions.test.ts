import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PeerService } from "./service.js";
import type { Peer } from "./state.js";
import type { AddonLocalContext } from "./compat/runtime.js";
import { runAction } from "./index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "peer-sessions-"));
  let deliveries = 0;
  const inputs: any[] = [];
  let target: any = { chatJid: "web:root:branch:second", incarnation: "branch-2", agentName: "smith", label: "Smith", active: false };
  const context: AddonLocalContext = {
    version: 1, accessMode: "single-user", kind: "operator",
    listTargets: async () => target ? [target] : [],
    resolveTarget: async (s) => target && s.chatJid === target.chatJid && s.incarnation === target.incarnation ? target : null,
  };
  let roster: any = { inbox: true, modes: ["queue"], agents: [], files: false };
  const options: any = {
    dataDir: root,
    runtime: { messaging: {
      listAdvertisableAgents: async () => [{ agent_name: "smith", active: false }],
      listAdvertisableSessions: async () => target ? [target] : [],
      resolveLocalTarget: async (s: any) => target && s.target_chat_jid === target.chatJid && s.target_incarnation === target.incarnation ? { status: "resolved", target_agent_name: target.agentName, incarnation: target.incarnation, active: target.active } : { status: "not_found" },
      deliverPeerMessage: async (input: any) => { input.signal?.throwIfAborted(); inputs.push(input); deliveries++; return { row_id: 1 }; },
    } },
    transportFactory: () => ({ id: "11".repeat(32), clientId: "local", close: async () => {}, status: () => ({ active: false }), request: async () => ({ body: roster }) }),
  };
  const service = new PeerService(options);
  service.state.saveConfig({ ...service.state.config(), enabled: true });
  const peer: Peer = { id: "22".repeat(32), alias: "lab", name: "Lab", status: "paired", request: "r", epoch: "e", expires: Date.now() + 60000, ticket: null, scope: "inbox-only", modes: ["queue", "auto"], agents: [], files: false, lastSeen: null };
  service.state.put(peer);
  const advertise = async () => {
    await service.advertise("smith", "research", ["queue", "auto"]);
    await runAction({ action: "session_advertise", agent: "research", session_alias: "second", chat_jid: target.chatJid, incarnation: target.incarnation, modes: ["queue", "auto"] }, service, context);
  };
  const selection = () => ({ agent: "research", session_alias: "second", revision: (service.state.db.query("SELECT revision FROM advertised_sessions WHERE agent='research' AND session_alias='second'").get() as { revision: string }).revision, modes: ["queue"] });
  const grant = () => service.setPolicy(peer.id, { ...peer, sessions: [selection()], confirmation: "ALLOW REMOTE ACCESS" });
  const receive = (target: string, mode = "queue", messageId = "m") => service.receive(peer.id, { op: "message", body: { epoch: "e", messageId, semantic: { target, mode, content: "hello", files: [] } } } as any, new Uint8Array());
  const getRoster = async () => (await service.receive(peer.id, { op: "roster", body: { epoch: "e" } } as any, new Uint8Array())).body;
  return { service, peer, context, options, root, advertise, selection, grant, receive, getRoster, inputs, deliveries: () => deliveries, target: (t: any) => { target = t; }, remote: (r: any) => { roster = r; }, close: async () => { await service.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("session advertise requires current operator context and exact incarnation; idle is valid", async () => {
  const f = fixture();
  try {
    await f.service.advertise("smith", "research", ["queue"]);
    const input = { agent: "research", session_alias: "second", chat_jid: "web:root:branch:second", incarnation: "branch-2", modes: ["queue"] as any };
    await expect(f.service.sessionAdvertise(input)).rejects.toThrow("current operator");
    await expect(f.service.sessionAdvertise(input, { ...f.context, kind: "agent" })).rejects.toThrow("current operator");
    await expect(f.service.sessionAdvertise({ ...input, incarnation: "" }, f.context)).rejects.toThrow("incarnation");
    await expect(f.service.sessionAdvertise({ ...input, incarnation: "old" }, f.context)).rejects.toThrow("stale");
    await f.advertise();
    expect((await f.service.dashboard(f.context)).advertised_sessions[0]).toMatchObject({ incarnation: "branch-2", status: "ready" });
    f.target(null);
    expect((await f.service.dashboard(f.context)).advertised_sessions[0].status).toBe("stale");
    expect((await f.service.dashboard()).advertised_sessions[0].status).toBe("stale");
    const expired = { ...f.context, resolveTarget: async () => { throw new Error("context_unavailable"); } };
    await expect(f.service.sessionAdvertise(input, expired)).rejects.toThrow("context_unavailable");
    await expect(f.service.localSessions()).rejects.toThrow("current operator");
  } finally { await f.close(); }
});

test("explicit per-peer session grants require typed confirmation and roster reveals only grants", async () => {
  const f = fixture();
  try {
    await f.advertise();
    expect((await f.getRoster()).sessions).toEqual([]);
    const before = f.service.state.peer(f.peer.id);
    expect(() => f.service.setPolicy(f.peer.id, { ...f.peer, sessions: [f.selection()] })).toThrow("ALLOW REMOTE ACCESS");
    expect(f.service.state.peer(f.peer.id)).toEqual(before);
    f.grant();
    const roster = await f.getRoster();
    expect(roster.sessions).toEqual([{ agent: "research", session_alias: "second", target_kind: "session", modes: ["queue"], status: "ready" }]);
    expect(JSON.stringify(roster)).not.toContain("web:");
    expect(JSON.stringify(roster)).not.toContain("branch-2");
    const other = { ...f.peer, id: "33".repeat(32), alias: "other", scope: "all-advertised" as const };
    f.service.state.put(other);
    expect((await f.service.receive(other.id, { op: "roster", body: { epoch: "e" } } as any, new Uint8Array())).body.sessions).toEqual([]);
    f.service.setPolicy(f.peer.id, { ...f.peer, modes: ["queue"], sessions: [] });
    expect((await f.getRoster()).sessions).toEqual([]);
    await expect(f.receive("@research/second")).rejects.toThrow("Session access denied");
  } finally { await f.close(); }
});

test("session parser and modes fail closed before inbound state or raw delivery", async () => {
  const f = fixture();
  try {
    await f.advertise();
    f.grant();
    for (const target of ["@research/second/extra", "@research/", "@/second", "@Research/second"])
      await expect(f.receive(target)).rejects.toThrow("Invalid target");
    await expect(f.receive("@research/missing")).rejects.toThrow("Session access denied");
    await expect(f.receive("@research/second", "auto")).rejects.toThrow("Session access denied");
    delete f.options.runtime.messaging.listAdvertisableSessions;
    await expect(f.receive("@research/second")).rejects.toThrow("incarnation-bound admission API unavailable");
    expect(f.deliveries()).toBe(0);
    expect(f.service.state.db.query("SELECT * FROM inbound").all()).toEqual([]);
    await f.service.revoke(f.peer.id, f.peer.id);
    await expect(f.receive("@research/second")).rejects.toThrow("not paired");
  } finally { await f.close(); }
});

test("unadvertise and replacement lifetimes remove grants, requiring explicit reapproval", async () => {
  const f = fixture();
  try {
    await f.advertise(); f.grant();
    f.target({ chatJid: "web:root:branch:second", incarnation: "replacement", agentName: "smith", active: false });
    await f.advertise();
    expect(f.service.state.peer(f.peer.id)?.sessions).toEqual([]);
    f.grant();
    await runAction({ action: "session_unadvertise", agent: "research", session_alias: "second" }, f.service, f.context);
    expect(f.service.state.peer(f.peer.id)?.sessions).toEqual([]);
    expect(f.service.state.db.query("SELECT * FROM advertised_sessions").all()).toEqual([]);
    await f.advertise(); f.grant();
    f.service.unadvertise("research");
    expect(f.service.state.peer(f.peer.id)?.sessions).toEqual([]);
    expect(f.service.state.db.query("SELECT * FROM advertised_sessions").all()).toEqual([]);
  } finally { await f.close(); }
});

test("session grant edits participate in atomic policy compare and survive legacy edits", async () => {
  const f = fixture();
  try {
    await f.advertise(); f.grant();
    const expected_policy = { ...f.peer };
    expect(() => f.service.setPolicy(f.peer.id, { ...f.peer, expected_policy, expected_epoch: "e" })).toThrow("changed");
    f.service.setPolicy(f.peer.id, { ...f.peer, confirmation: "ALLOW REMOTE ACCESS" });
    expect(f.service.state.peer(f.peer.id)?.sessions).toHaveLength(1);
    expect(() => f.service.setPolicy(f.peer.id, { ...f.peer, sessions: [{ ...f.selection(), session_alias: "missing" }], confirmation: "ALLOW REMOTE ACCESS" })).toThrow("not advertised");
    const grant = f.selection();
    expect(() => f.service.setPolicy(f.peer.id, { ...f.peer, sessions: [grant, grant], confirmation: "ALLOW REMOTE ACCESS" })).toThrow("Duplicate");
  } finally { await f.close(); }
});

test("session registry and grants persist; rotation clears both", async () => {
  const f = fixture();
  try {
    await f.advertise(); f.grant();
    await f.service.close();
    const reopened = new PeerService(f.options);
    try {
      expect(reopened.state.db.query("SELECT incarnation FROM advertised_sessions").get()).toEqual({ incarnation: "branch-2" });
      expect(reopened.state.peer(f.peer.id)?.sessions).toHaveLength(1);
      reopened.state.put({ ...reopened.state.peer(f.peer.id)!, status: "revoked" });
      reopened.state.rotateIdentity();
      expect(reopened.state.db.query("SELECT * FROM advertised_sessions").all()).toEqual([]);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("outbound directory supports session entries and rejects disallowed or unavailable modes", async () => {
  const f = fixture();
  try {
    f.remote({ inbox: false, modes: ["queue"], files: false, agents: [], sessions: [{ agent: "research", session_alias: "second", modes: ["queue"], status: "ready" }] });
    expect((await f.service.directory()).entries[0]).toMatchObject({ target_kind: "session", address: "lab!@research/second" });
    const request: any = { address: { raw: "lab!@research/second", peer: "lab", target: "@research/second" }, mode: "queue" };
    await f.service.validate(request);
    expect((await f.service.remotePermissions(f.peer.id)).sessions[0]).toMatchObject({ agent: "research", session_alias: "second", modes: ["queue"], status: "ready" });
    await expect(f.service.validate({ ...request, mode: "auto" })).rejects.toThrow("Address/mode");
    f.remote(await (async () => { await f.advertise(); f.grant(); return f.getRoster(); })());
    await f.service.validate(request);
    delete f.options.runtime.messaging.listAdvertisableSessions;
    f.remote(await f.getRoster());
    await expect(f.service.validate(request)).rejects.toThrow("Address/mode");
  } finally { await f.close(); }
});

test("no-grants draft consent cannot authorize a replacement alias with unchanged policy and epoch", async () => {
  const f = fixture();
  try {
    await f.advertise();
    const expected_policy = f.service.state.peer(f.peer.id)!;
    const grantEpoch = f.service.state.authorizationEpoch(f.peer.id);
    const draft = { ...expected_policy, sessions: [f.selection()], expected_policy, expected_epoch: expected_policy.epoch, confirmation: "ALLOW REMOTE ACCESS" };
    f.target({ chatJid: "web:replacement:B", incarnation: "B", agentName: "smith", active: false });
    await f.advertise();
    expect(f.service.state.peer(f.peer.id)).toEqual(expected_policy);
    expect(f.service.state.authorizationEpoch(f.peer.id)).toBe(grantEpoch);
    expect(f.selection().revision).not.toBe(draft.sessions[0].revision);
    expect(() => f.service.setPolicy(f.peer.id, draft)).toThrow("Session advertisement changed");
    expect(f.service.state.peer(f.peer.id)).toEqual(expected_policy);
    expect(f.service.state.authorizationEpoch(f.peer.id)).toBe(grantEpoch);
    expect((await f.getRoster()).sessions).toEqual([]);
    await expect(f.receive("@research/second")).rejects.toThrow("Session access denied");
    expect(f.service.state.db.query("SELECT * FROM inbound").all()).toEqual([]);
    const fresh = { ...draft, sessions: [f.selection()] };
    expect(() => f.service.setPolicy(f.peer.id, { ...fresh, confirmation: "" })).toThrow("ALLOW REMOTE ACCESS");
    f.service.setPolicy(f.peer.id, fresh);
    await f.receive("@research/second");
    expect(f.inputs[0]).toMatchObject({ target_chat_jid: "web:replacement:B", target_incarnation: "B" });
    expect(JSON.stringify(await f.getRoster())).not.toContain(f.selection().revision);
  } finally { await f.close(); }
});

test("every advertisement and Hide/re-advertise changes durable revision and blocks saved-grant reuse", async () => {
  const f = fixture();
  try {
    await f.advertise(); f.grant();
    const saved = f.service.state.peer(f.peer.id)!;
    const first = f.selection().revision;
    await f.advertise();
    const second = f.selection().revision;
    expect(second).not.toBe(first);
    expect(f.service.state.peer(f.peer.id)?.sessions).toEqual([]);
    // Even a restored old per-peer record cannot authorize the new revision.
    f.service.state.put(saved);
    expect((await f.getRoster()).sessions).toEqual([]);
    await expect(f.receive("@research/second")).rejects.toThrow("Session access denied");
    f.service.sessionUnadvertise("research", "second", f.context);
    await f.advertise();
    const third = f.selection().revision;
    expect(third).not.toBe(first); expect(third).not.toBe(second);
    await f.service.close();
    const reopened = new PeerService(f.options);
    try {
      expect((reopened.state.db.query("SELECT revision FROM advertised_sessions").get() as any).revision).toBe(third);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("missing session revision fails closed while file-only callers preserve unchanged grants", async () => {
  const f = fixture();
  try {
    await f.advertise();
    const legacy = { agent: "research", session_alias: "second", modes: ["queue"] };
    const before = f.service.state.peer(f.peer.id)!;
    const epoch = f.service.state.authorizationEpoch(f.peer.id);
    expect(() => f.service.setPolicy(f.peer.id, { ...before, sessions: [legacy], confirmation: "ALLOW REMOTE ACCESS" })).toThrow("requires selection");
    expect(f.service.state.peer(f.peer.id)).toEqual(before);
    expect(f.service.state.authorizationEpoch(f.peer.id)).toBe(epoch);
    f.grant();
    const granted = f.service.state.peer(f.peer.id)!.sessions;
    f.service.setPolicy(f.peer.id, { ...f.peer, files: true, confirmation: "ALLOW REMOTE ACCESS" });
    expect(f.service.state.peer(f.peer.id)!.sessions).toEqual(granted);
    await f.receive("@research/second");
    f.service.state.put({ ...f.service.state.peer(f.peer.id)!, sessions: [legacy] as any });
    f.service.setPolicy(f.peer.id, { ...f.peer, files: false, confirmation: "ALLOW REMOTE ACCESS" });
    expect(f.service.state.peer(f.peer.id)!.sessions).toEqual([legacy] as any);
    expect((await f.getRoster()).sessions).toEqual([]);
    await expect(f.receive("@research/second", "queue", "legacy")).rejects.toThrow("Session access denied");
  } finally { await f.close(); }
});

test("legacy registry migration assigns durable opaque revisions without upgrading saved consent", async () => {
  const f = fixture();
  try {
    await f.advertise();
    const legacy = { agent: "research", session_alias: "second", modes: ["queue"] };
    f.service.state.put({ ...f.peer, sessions: [legacy] as any });
    f.service.state.db.exec("ALTER TABLE advertised_sessions DROP COLUMN revision");
    await f.service.close();
    const reopened = new PeerService(f.options);
    try {
      const revision = (reopened.state.db.query("SELECT revision FROM advertised_sessions").get() as any).revision;
      expect(revision).toMatch(/^[0-9a-f-]{36}$/);
      expect(reopened.state.peer(f.peer.id)?.sessions).toEqual([legacy] as any);
      expect((await reopened.receive(f.peer.id, { op: "roster", body: { epoch: "e" } } as any, new Uint8Array())).body.sessions).toEqual([]);
      await expect(reopened.receive(f.peer.id, { op: "message", body: { epoch: "e", messageId: "legacy", semantic: { target: "@research/second", mode: "queue", content: "hello", files: [] } } } as any, new Uint8Array())).rejects.toThrow("Session access denied");
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("legacy inbox, agent, reply delivery remains unchanged", async () => {
  const f = fixture();
  try {
    await f.receive("inbox", "queue", "inbox");
    await f.service.advertise("smith", "research", ["queue"]);
    f.service.setPolicy(f.peer.id, { ...f.peer, scope: "named-agents", agents: ["research"], confirmation: "ALLOW REMOTE ACCESS" });
    await f.receive("@research", "queue", "agent");
    f.service.state.db.query("INSERT INTO replies VALUES (?,?,?,?,?)").run("token", f.peer.id, "e", "web:origin", Date.now() + 60000);
    await f.receive("reply.token", "queue", "reply");
    expect(f.deliveries()).toBe(3);
  } finally { await f.close(); }
});
