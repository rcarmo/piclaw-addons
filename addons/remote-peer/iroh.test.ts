import { test, expect } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { clientId, endpointId } from "./client-id.js";
import { PeerService } from "./service.js";
import { PeerState } from "./state.js";
import { IrohTransport } from "./transport.js";
import { normalizeRemotePeerConfig } from "./config.js";
function runtime() {
  const messages: any[] = [];
  return {
    messages,
    messaging: {
      version: 1,
      listAdvertisableAgents: async () => [
        { agent_name: "research", active: true },
      ],
      deliverPeerMessage: async (m) => {
        messages.push(m);
        return {
          status: "ok",
          chat_jid: "test",
          row_id: messages.length,
          thread_id: null,
          created: true,
        };
      },
    },
  } as any;
}
const config = normalizeRemotePeerConfig({
  enabled: true,
  instanceName: "test",
  relayMode: "disabled",
});
test("client IDs have checksums and reject legacy identities", () => {
  const id = "ab".repeat(32);
  expect(endpointId(clientId(id))).toBe(id);
  expect(() => endpointId(clientId(id).slice(0, -1) + "0")).toThrow();
  expect(() => endpointId("https://peer.example")).toThrow();
});
test("fresh state never reads old database/key and key persists securely", () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-state-"));
  try {
    writeFileSync(join(root, "state.db"), "legacy sentinel");
    writeFileSync(join(root, "identity.json"), "not a valid identity");
    const first = new PeerState(root);
    const key = first.keyBytes;
    expect(first.peers()).toEqual([]);
    expect(first.config().mdnsEnabled).toBe(false);
    if (process.platform !== "win32")
      expect(statSync(join(first.dir, "secret-key.bin")).mode & 0o777).toBe(
        0o600,
      );
    first.close();
    const next = new PeerState(root);
    expect(next.keyBytes).toEqual(key);
    next.close();
    expect(readFileSync(join(root, "state.db"), "utf8")).toBe(
      "legacy sentinel",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("default-off mDNS constructs no discovery resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-off-"));
  let created = 0;
  const service = new PeerService({
    dataDir: root,
    runtime: runtime(),
    discoveryFactory: () => {
      created++;
      throw Error("must not run");
    },
  });
  try {
    await service.start();
    expect(created).toBe(0);
    expect(service.transport.status().active).toBe(false);
    expect(() =>
      normalizeRemotePeerConfig({ externalUrl: "https://old" }),
    ).toThrow();
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("real loopback Iroh pair, approve, policy, bytes, retry receipt, restart and revoke", async () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-e2e-"));
  const aRuntime = runtime(),
    bRuntime = runtime();
  let a = new PeerService({
    dataDir: join(root, "a"),
    runtime: aRuntime,
    bindAddr: "127.0.0.1:0",
  });
  const b = new PeerService({
    dataDir: join(root, "b"),
    runtime: bRuntime,
    bindAddr: "127.0.0.1:0",
  });
  try {
    await a.configure(config);
    await b.configure(config);
    await a.pair({
      clientId: b.identity().clientId,
      alias: "beta",
      ticket: b.transport.ticket(),
    });
    expect(b.state.peers()[0].status).toBe("incoming");
    expect(bRuntime.messages.length).toBe(0);
    await b.accept(a.identity().endpointId, a.identity().clientId);
    expect(a.state.peers()[0].status).toBe("paired");
    expect(b.state.peers()[0].status).toBe("paired");
    expect((await a.ping("beta")).ok).toBe(true);
    await expect(
      a.transport.request(
        b.transport.id,
        "message",
        { epoch: "wrong" },
        new Uint8Array(),
        b.transport.ticket(),
      ),
    ).rejects.toThrow();
    b.setPolicy(a.transport.id, {
      scope: "named-agents",
      modes: ["queue", "auto"],
      agents: ["research"],
      files: true,
      confirmation: "ALLOW REMOTE ACCESS",
    });
    await b.advertise("research", "research", ["queue", "auto"]);
    const data = new TextEncoder().encode("binary\0file");
    const files = [
      {
        filename: "test.bin",
        content_type: "application/octet-stream",
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        data,
      },
    ];
    const request: any = {
      source_chat_jid: "web:origin",
      source_agent_name: "alpha",
      address: {
        kind: "bang",
        raw: "beta!@research",
        peer: "beta",
        target: "@research",
      },
      content: "IROH_ONLY_TEST",
      mode: "queue",
      attachments: files,
      idempotency_key: "one",
    };
    await a.validate(request);
    const receipt = await a.send(request);
    expect(receipt.relayed).toBe(true);
    expect(bRuntime.messages[0].attachments[0].data).toEqual(data);
    await a.send(request);
    expect(bRuntime.messages.length).toBe(1);
    // Simulate lost acknowledgement after receiver committed the receipt.
    a.state.db
      .query("UPDATE outbound SET status='failed',bytes=? WHERE id=?")
      .run(data, receipt.message_id as string);
    await a.retry(receipt.message_id as string);
    expect(bRuntime.messages.length).toBe(1);
    const replyAddress = bRuntime.messages[0].source.reply_address;
    expect(replyAddress).toContain("!reply.");
    const [peer, target] = replyAddress.split("!");
    const oldReplyRequest: any = {
      source_chat_jid: "web:remote",
      address: { kind: "bang", raw: replyAddress, peer, target },
      content: "REPLY",
      mode: "queue",
    };
    await b.send(oldReplyRequest);
    expect(aRuntime.messages[0].target_chat_jid).toBe("web:origin");
    const work = await a.workSend(
      "beta",
      "Review this change",
      "execute",
      ["review"],
      "",
    );
    expect(
      b.state.db.query("SELECT status FROM work WHERE id=?").get(work.id),
    ).toEqual({ status: "pending" });
    await b.reviewWork(work.id, "Reviewed", ["review"], true);
    expect(
      a.state.db.query("SELECT status FROM work WHERE id=?").get(work.id),
    ).toEqual({ status: "completed" });
    expect(bRuntime.messages.length).toBe(1); // No automatic tool/message execution for work.
    const aid = a.identity().clientId;
    await a.close();
    a = new PeerService({
      dataDir: join(root, "a"),
      runtime: aRuntime,
      bindAddr: "127.0.0.1:0",
    });
    expect(a.identity().clientId).toBe(aid);
    await a.start();
    await a.send(request);
    expect(bRuntime.messages.length).toBe(1);
    await expect(a.rotateIdentity("00".repeat(32))).rejects.toThrow("Confirm");
    await a.revoke("beta", b.identity().clientId);
    expect(a.state.peers()[0].status).toBe("revoked");
    expect(
      a.state.db
        .query("SELECT COUNT(*) AS n FROM replies WHERE peer=?")
        .get(b.identity().endpointId),
    ).toEqual({ n: 0 });
    await expect(
      b.send({ ...oldReplyRequest, idempotency_key: "old-reply-after-revoke" }),
    ).rejects.toThrow();
    await expect(
      a.send({ ...request, idempotency_key: "two" }),
    ).rejects.toThrow("paired");
    const rotated = await a.rotateIdentity(a.identity().clientId);
    expect(rotated.clientId).not.toBe(aid);
    expect(a.state.peers()).toEqual([]);
    expect(
      a.state.db.query("SELECT COUNT(*) AS n FROM outbound").get(),
    ).toEqual({ n: 0 });
    expect(
      a.state.db.query("SELECT COUNT(*) AS n FROM advertised").get(),
    ).toEqual({ n: 0 });
  } finally {
    await a.close();
    await b.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
