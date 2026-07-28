import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemotePeerConfig } from "../config.js";
import type { RemotePeerFoundation } from "../foundation.js";
import { createRemotePeerIdentity } from "../identity.js";
import { buildSignedHeaders, signCanonical, buildCallbackProof } from "../protocol/canonical.js";
import { openRemotePeerStore } from "../store/index.js";
import type { PeerRecord } from "./repository.js";
import { PairingService } from "./service.js";

const roots: string[] = [];
const foundations: RemotePeerFoundation[] = [];
const encoder = new TextEncoder();
const now = new Date("2026-01-01T00:00:00.000Z");

function foundation(name: string, enabled = true): RemotePeerFoundation {
  const root = mkdtempSync(join(tmpdir(), `remote-peer-${name}-`));
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
    enabled,
    instanceName: name,
    externalUrl: `http://${name}.test`,
    allowHttp: true,
    allowPrivateNetwork: true,
  }));
  return value;
}

function pairedRecord(remote: RemotePeerFoundation, base = "http://remote.test"): PeerRecord {
  return {
    instance_id: remote.identity.instance_id,
    peer_alias: "remote",
    public_key: remote.identity.public_key,
    fingerprint: remote.identity.fingerprint,
    display_name: "Remote",
    base_url: base,
    status: "paired",
    trust_epoch: 1,
    messaging_scope: "inbox-only",
    mode_ceiling: "queue",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_seen_at: null,
    blocked_reason: null,
  };
}

afterEach(() => {
  foundations.splice(0).forEach(value => value.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe("remote-peer pairing service", () => {
  test("gates all external routes when disabled and matches exact POST routes", async () => {
    const local = foundation("disabled", false);
    const service = new PairingService({ foundation: local, now: () => now });
    const disabled = await service.handle(new Request("http://disabled.test/api/addons/remote-peer/v1/ping", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), "/api/addons/remote-peer/v1/ping");
    expect(disabled.status).toBe(503);

    local.saveConfig({ ...local.loadConfig(), enabled: true });
    const get = await service.handle(new Request("http://disabled.test/api/addons/remote-peer/v1/ping"), "/api/addons/remote-peer/v1/ping");
    expect(get.status).toBe(405);
    const suffix = await service.handle(new Request("http://disabled.test/api/addons/remote-peer/v1/not-ping", { method: "POST" }), "/api/addons/remote-peer/v1/not-ping");
    expect(suffix.status).toBe(404);
  });

  test("accepts valid inbound pair requests and rejects invalid identity and rate abuse", async () => {
    const local = foundation("receiver");
    const remoteIdentity = createRemotePeerIdentity(now);
    const service = new PairingService({ foundation: local, now: () => now });
    const body = {
      instance_id: remoteIdentity.instance_id,
      public_key: remoteIdentity.public_key,
      display_name: "Remote Lab",
      callback_url: "http://remote.test/api/addons/remote-peer/v1/pair-callback",
      protocol_version: 1,
      trust_epoch: 1,
      nonce: "challenge",
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
    };
    const send = (value: unknown) => service.handle(new Request("http://receiver.test/api/addons/remote-peer/v1/pair-request", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
    }), "/api/addons/remote-peer/v1/pair-request");

    const invalid = await send({ ...body, public_key: "not-an-ed25519-key" });
    expect(invalid.status).toBe(400);
    const accepted = await send(body);
    expect(accepted.status).toBe(202);
    const payload = await accepted.json() as any;
    expect(payload.receiver_instance_id).toBe(local.identity.instance_id);
    expect(service.repository.getInbound(payload.request_id)?.status).toBe("pending");

    expect((await send(body)).status).toBe(202);
    expect((await send(body)).status).toBe(202);
    expect((await send(body)).status).toBe(429);
  });

  test("verifies exact signed ping bytes, prevents replay, and revokes remotely", async () => {
    const local = foundation("local");
    const remoteIdentity = createRemotePeerIdentity(now);
    const remote = { ...local, identity: remoteIdentity } as RemotePeerFoundation;
    const service = new PairingService({ foundation: local, now: () => now });
    service.repository.upsertPeer(pairedRecord(remote));

    const pingPath = "/api/addons/remote-peer/v1/ping";
    const raw = '{"time":"2026-01-01T00:00:00.000Z"}';
    const headers = buildSignedHeaders(remoteIdentity, pingPath, encoder.encode(raw), 1, now.toISOString(), "ping-nonce");
    const request = () => new Request(`http://local.test${pingPath}`, { method: "POST", headers, body: raw });
    expect((await service.handle(request(), pingPath)).status).toBe(200);
    expect((await service.handle(request(), pingPath)).status).toBe(401);

    const revokePath = "/api/addons/remote-peer/v1/revoke";
    const revokeRaw = '{"reason":"operator-revoked"}';
    const revokeHeaders = buildSignedHeaders(remoteIdentity, revokePath, encoder.encode(revokeRaw), 1, now.toISOString(), "revoke-nonce");
    const revoked = await service.handle(new Request(`http://local.test${revokePath}`, { method: "POST", headers: revokeHeaders, body: revokeRaw }), revokePath);
    expect(revoked.status).toBe(200);
    expect(service.repository.getPeer(remoteIdentity.instance_id)?.status).toBe("revoked");
    expect(service.repository.getPeer(remoteIdentity.instance_id)?.trust_epoch).toBe(2);
  });

  test("completes two-service pairing, signed ping, alias update, and revoke", async () => {
    const local = foundation("local");
    const remote = foundation("remote");
    const services = new Map<string, PairingService>();
    const dispatch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const target = services.get(url.hostname);
      if (!target) return new Response(JSON.stringify({ error: "missing target" }), { status: 502 });
      return await target.handle(request, url.pathname);
    };
    const localService = new PairingService({ foundation: local, fetch: dispatch, now: () => now });
    const remoteService = new PairingService({ foundation: remote, fetch: dispatch, now: () => now });
    services.set("local.test", localService);
    services.set("remote.test", remoteService);

    const outbound = await localService.initiatePairing("http://remote.test");
    const requestId = String(outbound.request_id);
    expect(localService.repository.getOutbound(requestId)?.status).toBe("pending");
    expect(remoteService.repository.getInbound(requestId)?.status).toBe("pending");

    const peer = await remoteService.acceptInbound(requestId);
    expect(peer.instance_id).toBe(local.identity.instance_id);
    expect(remoteService.repository.getPeer(local.identity.instance_id)?.status).toBe("paired");
    expect(localService.repository.getPeer(remote.identity.instance_id)?.status).toBe("paired");
    expect(localService.repository.getOutbound(requestId)?.status).toBe("accepted");

    expect((await localService.ping(remote.identity.instance_id)).status).toBe("ok");
    const aliased = localService.setAlias(remote.identity.instance_id, "remote-lab");
    expect(aliased.peer_alias).toBe("remote-lab");
    expect(localService.repository.getPeerByAlias("remote-lab")?.instance_id).toBe(remote.identity.instance_id);

    const result = await localService.revoke("remote-lab");
    expect(result.remote_notified).toBe(true);
    expect(result.peer.status).toBe("revoked");
    expect(result.peer.trust_epoch).toBe(2);
    expect(remoteService.repository.getPeer(local.identity.instance_id)?.status).toBe("revoked");

    const second = await localService.initiatePairing("http://remote.test");
    await remoteService.acceptInbound(String(second.request_id));
    expect(localService.repository.getPeer(remote.identity.instance_id)?.status).toBe("paired");
    expect(localService.repository.getPeer(remote.identity.instance_id)?.trust_epoch).toBe(3);
    expect(remoteService.repository.getPeer(local.identity.instance_id)?.status).toBe("paired");
    expect(remoteService.repository.getPeer(local.identity.instance_id)?.trust_epoch).toBe(3);
    expect((await localService.ping(remote.identity.instance_id)).status).toBe("ok");
  });

  test("revokes provisional trust when signed confirmation fails", async () => {
    const local = foundation("receiver");
    const remoteIdentity = createRemotePeerIdentity(now);
    let calls = 0;
    const service = new PairingService({
      foundation: local,
      now: () => now,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({
            request_id: "pair-confirm-failure",
            challenge: "challenge",
            instance_id: remoteIdentity.instance_id,
            signature: signCanonical(remoteIdentity, buildCallbackProof("pair-confirm-failure", "challenge", local.identity.instance_id)),
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "rejected" }), { status: 401 });
      },
    });
    service.repository.createInbound({
      id: "pair-confirm-failure",
      instance_id: remoteIdentity.instance_id,
      public_key: remoteIdentity.public_key,
      fingerprint: remoteIdentity.fingerprint,
      display_name: "Remote",
      callback_url: "http://remote.test/api/addons/remote-peer/v1/pair-callback",
      protocol_version: 1,
      nonce: "challenge",
      status: "pending",
      source_key: "external",
      trust_epoch: 1,
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });

    expect(service.acceptInbound("pair-confirm-failure")).rejects.toThrow("confirmation failed");
    expect(service.repository.getInbound("pair-confirm-failure")?.status).toBe("failed");
    expect(service.repository.getPeer(remoteIdentity.instance_id)?.status).toBe("revoked");
    expect(service.repository.getPeer(remoteIdentity.instance_id)?.trust_epoch).toBe(2);
  });

  test("fails closed when URL ownership proof is invalid", async () => {
    const local = foundation("receiver");
    const remoteIdentity = createRemotePeerIdentity(now);
    const service = new PairingService({
      foundation: local,
      now: () => now,
      fetch: async () => new Response(JSON.stringify({ request_id: "wrong", challenge: "wrong", instance_id: remoteIdentity.instance_id, signature: signCanonical(remoteIdentity, buildCallbackProof("wrong", "wrong", local.identity.instance_id)) }), { status: 200 }),
    });
    const id = "pair-proof";
    service.repository.createInbound({
      id,
      instance_id: remoteIdentity.instance_id,
      public_key: remoteIdentity.public_key,
      fingerprint: remoteIdentity.fingerprint,
      display_name: "Remote",
      callback_url: "http://remote.test/api/addons/remote-peer/v1/pair-callback",
      protocol_version: 1,
      nonce: "challenge",
      status: "pending",
      source_key: "external",
      trust_epoch: 1,
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });

    expect(service.acceptInbound(id)).rejects.toThrow("ownership proof failed");
    expect(service.repository.getInbound(id)?.status).toBe("failed");
    expect(service.repository.getPeer(remoteIdentity.instance_id)).toBeNull();
  });
});
