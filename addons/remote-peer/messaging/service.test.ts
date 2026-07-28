import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatTransportRequest, PiclawRuntimeApi } from "../compat/runtime.js";
import { normalizeRemotePeerConfig } from "../config.js";
import type { RemotePeerFoundation } from "../foundation.js";
import { createRemotePeerIdentity } from "../identity.js";
import { PairingService } from "../pairing/service.js";
import { openRemotePeerStore } from "../store/index.js";
import { MessagingService } from "./service.js";

const roots: string[] = [];
const foundations: RemotePeerFoundation[] = [];
const now = new Date("2026-01-01T00:00:00.000Z");

function foundation(name: string): RemotePeerFoundation {
  const root = mkdtempSync(join(tmpdir(), `remote-peer-message-${name}-`));
  roots.push(root);
  const store = openRemotePeerStore(root);
  const value: RemotePeerFoundation = {
    dataDir: root,
    identity: createRemotePeerIdentity(now),
    store,
    loadConfig: () => store.loadConfig(),
    saveConfig: config => store.saveConfig(config),
    close: () => store.close(),
  };
  foundations.push(value);
  value.saveConfig(normalizeRemotePeerConfig({
    enabled: true,
    instanceName: name,
    externalUrl: `http://${name}.test`,
    allowHttp: true,
    allowPrivateNetwork: true,
  }));
  return value;
}

function runtimeMessaging(deliveries: any[]): NonNullable<PiclawRuntimeApi["messaging"]> {
  return {
    version: 1,
    registerChatTransport: () => () => {},
    getAddonDataDir: () => "",
    listAdvertisableAgents: async () => [],
    resolveLocalTarget: async () => ({ status: "resolved", agent_name: "inbox", active: true }),
    deliverPeerMessage: async input => {
      deliveries.push(input);
      return { status: "ok", chat_jid: "web:default", row_id: 123, thread_id: null, created: true };
    },
  };
}

function request(overrides: Partial<ChatTransportRequest> = {}): ChatTransportRequest {
  return {
    source_chat_jid: "web:sender",
    address: { kind: "bang", raw: "remote!inbox", peer: "remote", target: "inbox" },
    content: "Please review this finding.",
    mode: "queue",
    idempotency_key: "idem-1",
    ...overrides,
  };
}

async function pairedServices() {
  const local = foundation("local");
  const remote = foundation("remote");
  const localDeliveries: any[] = [];
  const remoteDeliveries: any[] = [];
  const pairing = new Map<string, PairingService>();
  const localMessages = new MessagingService({ foundation: local, messaging: runtimeMessaging(localDeliveries), now: () => now });
  const remoteMessages = new MessagingService({ foundation: remote, messaging: runtimeMessaging(remoteDeliveries), now: () => now });
  const dispatch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const target = pairing.get(url.hostname);
    if (!target) return new Response(JSON.stringify({ error: "missing target" }), { status: 502 });
    return await target.handle(req, url.pathname);
  };
  const localPairing = new PairingService({ foundation: local, fetch: dispatch, now: () => now, messaging: localMessages });
  const remotePairing = new PairingService({ foundation: remote, fetch: dispatch, now: () => now, messaging: remoteMessages });
  pairing.set("local.test", localPairing);
  pairing.set("remote.test", remotePairing);

  const pending = await localPairing.initiatePairing("http://remote.test");
  await remotePairing.acceptInbound(String(pending.request_id));
  return { local, remote, localMessages, remoteMessages, localDeliveries, remoteDeliveries, dispatch };
}

afterEach(() => {
  foundations.splice(0).forEach(value => value.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe("remote-peer signed inbox messaging", () => {
  test("delivers peer!inbox through core and persists signed ledgers and receipt", async () => {
    const setup = await pairedServices();
    const service = new MessagingService({ foundation: setup.local, messaging: runtimeMessaging(setup.localDeliveries), fetch: setup.dispatch, now: () => now });
    const result = await service.send(request());

    expect(result.relayed).toBe(true);
    expect(result.peer_instance_id).toBe(setup.remote.identity.instance_id);
    expect((result.receipt as any).status).toBe("queued");
    expect(setup.remoteDeliveries).toHaveLength(1);
    expect(setup.remoteDeliveries[0]).toMatchObject({
      target_agent_name: "default",
      content: "Please review this finding.",
      mode: "queue",
      source: {
        peer_instance_id: setup.local.identity.instance_id,
        peer_fingerprint: setup.local.identity.fingerprint,
        message_id: expect.stringMatching(/^rmsg_/),
      },
    });
    expect(service.repository.listOutbound()).toHaveLength(1);
    expect(service.repository.listOutbound()[0].status).toBe("delivered");
    expect(setup.remoteMessages.repository.listInbound()).toHaveLength(1);
    expect(setup.remoteMessages.repository.listInbound()[0].status).toBe("queued");
    expect((setup.local.store.db.query("SELECT COUNT(*) AS count FROM message_receipts").get() as any).count).toBe(1);
    expect((setup.remote.store.db.query("SELECT COUNT(*) AS count FROM message_receipts").get() as any).count).toBe(1);
  });

  test("returns the original receipt for duplicate retries without a second timeline row", async () => {
    const setup = await pairedServices();
    const service = new MessagingService({ foundation: setup.local, messaging: runtimeMessaging(setup.localDeliveries), fetch: setup.dispatch, now: () => now });
    const first = await service.send(request());
    const second = await service.send(request());

    expect(second.receipt).toEqual(first.receipt);
    expect(second.message_id).toBe(first.message_id);
    expect(setup.remoteDeliveries).toHaveLength(1);
    expect(service.repository.listOutbound()).toHaveLength(1);
    expect(setup.remoteMessages.repository.listInbound()).toHaveLength(1);
  });

  test("blocks a concurrent local idempotent retry while the first HTTP send is in flight", async () => {
    const setup = await pairedServices();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    const delayedFetch: typeof fetch = async (input, init) => {
      requests += 1;
      await gate;
      return await setup.dispatch(input, init);
    };
    const service = new MessagingService({ foundation: setup.local, messaging: runtimeMessaging(setup.localDeliveries), fetch: delayedFetch, now: () => now });
    const first = service.send(request());
    await Bun.sleep(10);
    await expect(service.send(request())).rejects.toThrow("already in progress");
    expect(requests).toBe(1);
    release();
    await first;
    expect(setup.remoteDeliveries).toHaveLength(1);
  });

  test("receiver replay returns the exact stored receipt without a second timeline row", async () => {
    const setup = await pairedServices();
    const peer = new (await import("../pairing/repository.js")).PairingRepository(setup.remote.store.db).getPeer(setup.local.identity.instance_id)!;
    const body = {
      protocol_version: 1,
      message_id: `rmsg_${"r".repeat(20)}`,
      idempotency_key: "receiver-retry",
      target: { kind: "inbox" },
      content: "retry me",
      mode: "queue",
      source_agent_name: null,
      in_reply_to: null,
    };
    const first = await setup.remoteMessages.receive(peer, body);
    const second = await setup.remoteMessages.receive(peer, body);

    expect(await second.json()).toEqual(await first.json());
    expect(setup.remoteDeliveries).toHaveLength(1);
    expect(setup.remoteMessages.repository.listInbound()).toHaveLength(1);
  });

  test("rejects unadvertised aliases, higher modes, idempotency collisions, and spoofed unsigned identity", async () => {
    const setup = await pairedServices();
    const service = new MessagingService({ foundation: setup.local, messaging: runtimeMessaging(setup.localDeliveries), fetch: setup.dispatch, now: () => now });
    await expect(service.send(request({ idempotency_key: "alias-attempt", address: { kind: "bang", raw: "remote!@research", peer: "remote", target: "@research" } }))).rejects.toThrow("not advertised");
    await expect(service.send(request({ idempotency_key: "auto-attempt", mode: "auto" }))).rejects.toThrow("not allowed");
    await service.send(request());
    await expect(service.send(request({ content: "different" }))).rejects.toThrow("different message");

    const unsignedBody = JSON.stringify({
      protocol_version: 1,
      message_id: `rmsg_${"x".repeat(20)}`,
      target: { kind: "inbox" },
      content: "spoof",
      mode: "queue",
      source_instance_id: "attacker",
      in_reply_to: null,
    });
    const unsigned = await setup.dispatch("http://remote.test/api/addons/remote-peer/v1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Instance-Id": setup.local.identity.instance_id },
      body: unsignedBody,
    });
    expect(unsigned.status).toBe(401);
    expect(setup.remoteDeliveries).toHaveLength(1);
  });

  test("routes only advertised aliases and enforces peer plus alias mode ceilings", async () => {
    const setup = await pairedServices();
    const localService = new MessagingService({ foundation: setup.local, messaging: runtimeMessaging(setup.localDeliveries), fetch: setup.dispatch, now: () => now });
    setup.remoteMessages.policy.upsertAdvertisedAgent("research", "research-local", ["queue", "auto"], now.toISOString());
    const remotePeer = new (await import("../pairing/repository.js")).PairingRepository(setup.remote.store.db).getPeer(setup.local.identity.instance_id)!;
    setup.remoteMessages.policy.updatePeerPolicy(remotePeer.instance_id, "named-agents", "queue-auto-steer", now.toISOString());
    setup.remoteMessages.policy.setPeerAgents(remotePeer.instance_id, ["research"], now.toISOString());
    const localPeer = new (await import("../pairing/repository.js")).PairingRepository(setup.local.store.db).getPeer(setup.remote.identity.instance_id)!;
    localService.policy.updatePeerPolicy(localPeer.instance_id, "all-advertised", "queue-auto-steer", now.toISOString());

    const delivered = await localService.send(request({
      idempotency_key: "agent-queue",
      address: { kind: "bang", raw: "remote!@research", peer: "remote", target: "@research" },
    }));
    expect((delivered.receipt as any).target_agent_name).toBe("research");
    expect(setup.remoteDeliveries.at(-1)).toMatchObject({ target_agent_name: "research-local", mode: "queue" });

    await expect(localService.send(request({
      idempotency_key: "agent-steer",
      mode: "steer",
      address: { kind: "bang", raw: "remote!@research", peer: "remote", target: "@research" },
    }))).rejects.toThrow("not allowed");
    setup.remoteMessages.policy.upsertAdvertisedAgent("research", "research-local", ["queue", "auto", "steer"], now.toISOString());
    const steered = await localService.send(request({
      idempotency_key: "agent-steer-approved",
      mode: "steer",
      address: { kind: "bang", raw: "remote!@research", peer: "remote", target: "@research" },
    }));
    expect((steered.receipt as any).status).toBe("queued");
    expect(setup.remoteDeliveries.at(-1).mode).toBe("steer");
  });

  test("opaque reply addresses return to the original source chat without exposing its JID", async () => {
    const setup = await pairedServices();
    const localService = new MessagingService({ foundation: setup.local, messaging: runtimeMessaging(setup.localDeliveries), fetch: setup.dispatch, now: () => now });
    const remoteService = new MessagingService({ foundation: setup.remote, messaging: runtimeMessaging(setup.remoteDeliveries), fetch: setup.dispatch, now: () => now });
    const first = await localService.send(request({ source_chat_jid: "web:secret-source", idempotency_key: "reply-origin" }));
    expect((first.receipt as any).status).toBe("queued");
    const replyAddress = setup.remoteDeliveries.at(-1).source.reply_address as string;
    expect(replyAddress).toContain("!reply.");
    expect(replyAddress).not.toContain("web:secret-source");

    const [peerAlias, target] = replyAddress.split("!", 2);
    expect(peerAlias).toBe("local");
    const reply = await remoteService.send(request({
      source_chat_jid: "web:remote-agent",
      idempotency_key: "reply-return",
      content: "Reply received.",
      address: { kind: "bang", raw: replyAddress, peer: peerAlias, target },
      in_reply_to: String(first.message_id),
    }));
    expect((reply.receipt as any).target_agent_name).toBe("reply");
    expect(setup.localDeliveries.at(-1)).toMatchObject({
      target_chat_jid: "web:secret-source",
      content: "Reply received.",
      source: { in_reply_to: String(first.message_id) },
    });
    expect(localService.listInbound().at(-1)?.target_agent_name).toBe("reply");
    expect(JSON.stringify(localService.listInbound())).not.toContain("web:secret-source");
  });

  test("uses authenticated peer identity and ignores spoofable body source fields", async () => {
    const setup = await pairedServices();
    const peer = new (await import("../pairing/repository.js")).PairingRepository(setup.remote.store.db).getPeer(setup.local.identity.instance_id)!;
    const body = {
      protocol_version: 1,
      message_id: `rmsg_${"x".repeat(20)}`,
      target: { kind: "inbox" },
      content: "spoof attempt",
      mode: "queue",
      source_agent_name: "reported-agent",
      source_instance_id: "attacker",
      source_fingerprint: "forged",
      in_reply_to: null,
    };
    const response = await setup.remoteMessages.receive(peer, body);
    expect(response.status).toBe(200);
    expect(setup.remoteDeliveries.at(-1).source).toMatchObject({
      peer_instance_id: setup.local.identity.instance_id,
      peer_fingerprint: setup.local.identity.fingerprint,
      agent_name: "reported-agent",
    });
  });
});
