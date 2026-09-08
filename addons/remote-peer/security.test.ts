import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IrohTransport,
  ALPN,
  iroh,
  MAX_BYTES,
  resolveRelayConfigs,
} from "./transport.js";
import { normalizeRemotePeerConfig } from "./config.js";
import { PeerService } from "./service.js";
const config = normalizeRemotePeerConfig({
  enabled: true,
  relayMode: "disabled",
});
const make = () =>
  new IrohTransport({
    keyBytes: Array.from(randomBytes(32)),
    config,
    bindAddr: "127.0.0.1:0",
    handler: async () => ({ body: { ok: true } }),
  });
test("custom relay credentials resolve from keychain references without entering config", async () => {
  const config = normalizeRemotePeerConfig({
    relayMode: "custom",
    relays: [
      { url: "https://relay.example", authTokenKeychain: "iroh/relay-token" },
    ],
  });
  const fromEnv = await resolveRelayConfigs(
    config,
    { IROH_RELAY_TOKEN: "secret" },
    null,
  );
  expect(fromEnv).toEqual([
    { url: "https://relay.example/", authToken: "secret" },
  ]);
  const fromBridge = await resolveRelayConfigs(
    config,
    {},
    {
      getKeychainEntry: async (name: string) => ({
        name,
        secret: "bridge-secret",
      }),
    },
  );
  expect(fromBridge).toEqual([
    { url: "https://relay.example/", authToken: "bridge-secret" },
  ]);
  await expect(resolveRelayConfigs(config, {}, null)).rejects.toThrow(
    "unavailable",
  );
  expect(JSON.stringify(config)).not.toContain("secret");
});

test("signed envelopes reject altered bytes, identity, replay, timestamp and operation fields", async () => {
  const a = make(),
    b = make();
  try {
    const bytes = new TextEncoder().encode("signed");
    const packet = (a as any).packet(b.id, "test", { ok: true }, bytes);
    (b as any).validate(packet, a.id, bytes);
    expect(() => (b as any).validate(packet, a.id, bytes)).toThrow("Replay");
    for (const patch of [
      { from: b.id },
      { to: a.id },
      { time: 0 },
      { size: 100 },
      { hash: "bad" },
      { op: "tampered" },
      { signature: "AA==" },
      { extra: "unknown" },
    ])
      expect(() =>
        (b as any).validate(
          { ...packet, ...patch, nonce: "unique" },
          a.id,
          bytes,
        ),
      ).toThrow();
  } finally {
    await a.close();
    await b.close();
  }
});
test("malformed/oversized frame denied before allocating body or calling application", async () => {
  const t = make();
  try {
    for (const size of [0, 193 * 1024]) {
      const h = Buffer.alloc(4);
      h.writeUInt32BE(size);
      let count = 0;
      await expect(
        (t as any).read({
          readExact: async () => {
            count++;
            return [...h];
          },
        }),
      ).rejects.toThrow();
      expect(count).toBe(1);
    }
    const h = Buffer.from(JSON.stringify({ size: MAX_BYTES + 1 })),
      prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(h.length);
    let i = 0;
    await expect(
      (t as any).read({ readExact: async () => Array.from(i++ ? h : prefix) }),
    ).rejects.toThrow("body length");
    expect(i).toBe(2);
  } finally {
    await t.close();
  }
});
test("wrong ALPN and ticket identity rejected on real loopback endpoints", async () => {
  const a = make(),
    b = make();
  try {
    await a.start();
    await b.start();
    await expect(
      (a as any).endpoint.connect(
        iroh().EndpointTicket.fromString(b.ticket()).endpointAddr(),
        Array.from(Buffer.from(ALPN + "-old")),
      ),
    ).rejects.toThrow();
    await expect(
      a.request(b.id, "ping", {}, new Uint8Array(), a.ticket()),
    ).rejects.toThrow("match");
    await expect(a.request(b.id, "ping")).rejects.toThrow("address lookup");
  } finally {
    await a.close();
    await b.close();
  }
}, 20000);
test("pair expiry accepts bounded clock skew but rejects stale and far-future requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-skew-"));
  const service = new PeerService({
    dataDir: root,
    runtime: {
      messaging: {
        version: 1,
        listAdvertisableAgents: async () => [],
        deliverPeerMessage: async () => ({}),
      },
    } as any,
  });
  const packet = (expires: number) =>
    ({
      body: {
        request: "request",
        epoch: "epoch",
        expires,
        name: "peer",
        ticket: "bad",
      },
    }) as any;
  try {
    await service.configure({ enabled: true, relayMode: "disabled" });
    await expect(
      service.receive(
        "22".repeat(32),
        { ...packet(Date.now() - 91000), op: "pair" },
        new Uint8Array(),
      ),
    ).rejects.toThrow("Invalid pairing request");
    await expect(
      service.receive(
        "33".repeat(32),
        { ...packet(Date.now() + 3600000 + 91000), op: "pair" },
        new Uint8Array(),
      ),
    ).rejects.toThrow("Invalid pairing request");
    await expect(
      service.receive(
        "44".repeat(32),
        { ...packet(Date.now() - 30000), op: "pair" },
        new Uint8Array(),
      ),
    ).rejects.toThrow();
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("default-off discovery, settings toggle and disable release resources with no native multicast", async () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-toggle-"));
  let starts = 0,
    stops = 0;
  const runtime: any = {
    messaging: {
      version: 1,
      listAdvertisableAgents: async () => [],
      deliverPeerMessage: async () => ({}),
    },
  };
  const service = new PeerService({
    dataDir: root,
    runtime,
    bindAddr: "127.0.0.1:0",
    discoveryFactory: () =>
      ({
        start: async () => {
          starts++;
        },
        stop: async () => {
          stops++;
        },
        status: () => ({ active: true, error: null }),
        candidates: () => [],
      }) as any,
  });
  try {
    await service.configure(config);
    expect(starts).toBe(0);
    await service.configure({ mdnsEnabled: true });
    expect(starts).toBe(1);
    await service.configure({ mdnsEnabled: false });
    expect(stops).toBe(1);
    expect(service.discovery).toBe(null);
    await service.configure({ enabled: false });
    expect(service.transport.status().active).toBe(false);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
