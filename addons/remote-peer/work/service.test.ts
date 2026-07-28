import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiclawRuntimeApi } from "../compat/runtime.js";
import { normalizeRemotePeerConfig } from "../config.js";
import type { RemotePeerFoundation } from "../foundation.js";
import { createRemotePeerIdentity } from "../identity.js";
import { PairingService } from "../pairing/service.js";
import { openRemotePeerStore } from "../store/index.js";
import { WorkService } from "./service.js";

const roots: string[] = [];
const foundations: RemotePeerFoundation[] = [];
let time = Date.parse("2026-01-01T00:00:00.000Z");
const now = () => new Date(time);

function foundation(name: string): RemotePeerFoundation {
  const root = mkdtempSync(join(tmpdir(), `remote-peer-work-${name}-`));
  roots.push(root);
  const store = openRemotePeerStore(root);
  const value: RemotePeerFoundation = {
    dataDir: root, identity: createRemotePeerIdentity(now()), store,
    loadConfig: () => store.loadConfig(), saveConfig: config => store.saveConfig(config), close: () => store.close(),
  };
  foundations.push(value);
  value.saveConfig(normalizeRemotePeerConfig({ enabled: true, instanceName: name, externalUrl: `http://${name}.test`, allowHttp: true, allowPrivateNetwork: true }));
  return value;
}

function runtime(deliveries: any[]): PiclawRuntimeApi {
  return {
    enqueueAgentMessage: async request => {
      deliveries.push(request);
      return { status: "ok", chat_jid: request.chatJid, row_id: 1, thread_id: null, created: true };
    },
  };
}

async function setup() {
  const local = foundation("local");
  const remote = foundation("remote");
  const localResults: any[] = [];
  const remoteResults: any[] = [];
  const pairings = new Map<string, PairingService>();
  let failResults = false;
  const dispatch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (failResults && url.pathname.endsWith("/result")) return new Response(JSON.stringify({ error: "offline" }), { status: 503 });
    const service = pairings.get(url.hostname);
    if (!service) return new Response(JSON.stringify({ error: "missing" }), { status: 502 });
    return await service.handle(request, url.pathname);
  };
  const localWork = new WorkService({ foundation: local, runtime: runtime(localResults), fetch: dispatch, now });
  const remoteWork = new WorkService({ foundation: remote, runtime: runtime(remoteResults), fetch: dispatch, now });
  const localPairing = new PairingService({ foundation: local, fetch: dispatch, now, work: localWork });
  const remotePairing = new PairingService({ foundation: remote, fetch: dispatch, now, work: remoteWork });
  pairings.set("local.test", localPairing); pairings.set("remote.test", remotePairing);
  const pending = await localPairing.initiatePairing("http://remote.test");
  await remotePairing.acceptInbound(String(pending.request_id));
  const localPeer = localPairing.repository.getPeer(remote.identity.instance_id)!;
  return { local, remote, localWork, remoteWork, localResults, remoteResults, localPeer, dispatch, setFailResults: (value: boolean) => { failResults = value; } };
}

afterEach(() => {
  foundations.splice(0).forEach(value => value.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  time = Date.parse("2026-01-01T00:00:00.000Z");
});

describe("remote-peer mediated work", () => {
  test("queues proposal and execute requests for atomic operator approval", async () => {
    const s = await setup();
    for (const requestType of ["proposal", "execute"] as const) {
      const sent = await s.localWork.send({ peer: s.localPeer, prompt: `Review ${requestType}`, requestType, capabilityProfile: "restricted", capabilities: ["analyze"], originChatJid: "web:origin" });
      expect(sent.status).toBe("pending");
    }
    expect(s.remoteWork.listInbox()).toHaveLength(2);
    const requestId = String(s.remoteWork.listInbox()[0].request_id);
    const approved = await s.remoteWork.approve(requestId, "Reviewed result", ["analyze"]);
    expect(approved.status).toBe("completed");
    expect(s.localWork.status(requestId)).toMatchObject({ status: "completed", result: "Reviewed result", allowed_capabilities: ["analyze"] });
    expect(s.localResults.at(-1)).toMatchObject({ chatJid: "web:origin", source: "addon.remote-peer" });
    await expect(s.remoteWork.approve(requestId, "again", [])).rejects.toThrow("Pending inbound");
  });

  test("persists pending state across service reconstruction and supports wait/reject", async () => {
    const s = await setup();
    const sent = await s.localWork.send({ peer: s.localPeer, prompt: "Persistent work", originChatJid: "web:origin" });
    const reconstructed = new WorkService({ foundation: s.remote, runtime: runtime([]), fetch: s.dispatch, now });
    expect(reconstructed.status(String(sent.request_id)).status).toBe("pending");
    const waiting = await s.localWork.wait(String(sent.request_id), 0);
    expect(waiting.status).toBe("pending");
    await reconstructed.reject(String(sent.request_id), "Not approved");
    expect((await s.localWork.wait(String(sent.request_id), 1000)).status).toBe("rejected");
  });

  test("enforces capability profiles and chain limits/loops", async () => {
    const s = await setup();
    await expect(s.localWork.send({ peer: s.localPeer, prompt: "Shell", capabilities: ["shell"] })).rejects.toThrow("allowlist");
    const first = await s.localWork.send({ peer: s.localPeer, prompt: "First", capabilities: ["analyze"], chainId: "chain-one", chainHop: 0 });
    expect(first.status).toBe("pending");
    await expect(s.localWork.send({ peer: s.localPeer, prompt: "Loop", capabilities: ["analyze"], chainId: "chain-one", chainHop: 1 })).rejects.toThrow("loop");
    await expect(s.localWork.send({ peer: s.localPeer, prompt: "Hop", capabilities: ["analyze"], chainId: "chain-two", chainHop: 3 })).rejects.toThrow("hop limit");
    await expect(s.remoteWork.approve(String(first.request_id), "bad", ["shell"])).rejects.toThrow("subset");
  });

  test("rejects unknown, duplicate, and conflicting callbacks", async () => {
    const s = await setup();
    const unknown = await s.localWork.receiveResult(s.localPeer, { request_id: "rwork_missing", status: "completed", result: "x" });
    expect(unknown.status).toBe(404);
    const sent = await s.localWork.send({ peer: s.localPeer, prompt: "Once" });
    await s.remoteWork.approve(String(sent.request_id), "done", []);
    const peerOnLocal = s.localPeer;
    const duplicateBody = { request_id: sent.request_id, status: "completed", result: "done" };
    expect((await s.localWork.receiveResult(peerOnLocal, duplicateBody)).status).toBe(409);
    expect((await s.localWork.receiveResult(peerOnLocal, { ...duplicateBody, result: "different" })).status).toBe(409);
  });

  test("keeps callback completion retryable when origin chat routing fails", async () => {
    const s = await setup();
    const sent = await s.localWork.send({ peer: s.localPeer, prompt: "Route retry", originChatJid: "web:origin" });
    const failingOrigin = new WorkService({
      foundation: s.local,
      fetch: s.dispatch,
      now,
      runtime: { enqueueAgentMessage: async () => { throw new Error("origin queue unavailable"); } },
    });
    await expect(failingOrigin.receiveResult(s.localPeer, { request_id: sent.request_id, status: "completed", result: "later", allowed_capabilities: [] })).rejects.toThrow("origin queue unavailable");
    expect(s.localWork.status(String(sent.request_id)).status).toBe("pending");
  });

  test("persists failed callbacks and retries them after reconnect", async () => {
    const s = await setup();
    const sent = await s.localWork.send({ peer: s.localPeer, prompt: "Retry callback", originChatJid: "web:origin" });
    s.setFailResults(true);
    await expect(s.remoteWork.approve(String(sent.request_id), "eventual", [])).rejects.toThrow("HTTP 503");
    expect(s.remoteWork.repository.listDueCallbacks(now().toISOString())).toHaveLength(0);
    time += 31_000;
    s.setFailResults(false);
    expect(await s.remoteWork.retryDueCallbacks()).toBe(1);
    expect(s.localWork.status(String(sent.request_id))).toMatchObject({ status: "completed", result: "eventual" });
  });
});
