import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PeerService } from "./service.js";
class FakeTransport {
  id = "11".repeat(32);
  clientId = "PCL1-test";
  active = false;
  closeCount = 0;
  constructor(public options: any) {}
  async start() {
    await Bun.sleep(5);
    this.active = true;
  }
  async close() {
    await Bun.sleep(5);
    this.closeCount++;
    this.active = false;
  }
  status() {
    return { active: this.active };
  }
  port() {
    return 1234;
  }
  ticket() {
    return "ticket";
  }
}
const runtime = {
  messaging: {
    version: 1,
    listAdvertisableAgents: async () => [],
    deliverPeerMessage: async () => ({}),
  },
} as any;
test("configure, rotate and close are serialised; closing prevents resurrection", async () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-lifecycle-"));
  const transports: FakeTransport[] = [];
  const service = new PeerService({
    dataDir: root,
    runtime,
    transportFactory: (o) => {
      const t = new FakeTransport(o);
      transports.push(t);
      return t as any;
    },
  });
  try {
    await service.configure({ enabled: true, relayMode: "disabled" });
    const configure = service.configure({ instanceName: "changed" });
    const close = service.close();
    await configure;
    await close;
    expect(service.transport.status().active).toBe(false);
    expect(transports.filter((t) => t.active)).toHaveLength(0);
    await expect(service.configure({ enabled: true })).rejects.toThrow(
      "closing",
    );
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("rejected rotation performs preflight before stopping the current endpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-rotation-"));
  const transports: FakeTransport[] = [];
  const service = new PeerService({
    dataDir: root,
    runtime,
    transportFactory: (o) => {
      const t = new FakeTransport(o);
      transports.push(t);
      return t as any;
    },
  });
  try {
    await service.configure({ enabled: true, relayMode: "disabled" });
    service.state.put({
      id: "22".repeat(32),
      alias: "peer",
      name: "",
      status: "paired",
      request: "r",
      expires: Date.now() + 1000,
      epoch: "e",
      ticket: null,
      scope: "inbox-only",
      modes: ["queue"],
      agents: [],
      files: false,
      lastSeen: null,
    });
    const active = service.transport;
    await expect(
      service.rotateIdentity(service.identity().endpointId),
    ).rejects.toThrow("Revoke every peer");
    expect(service.transport).toBe(active);
    expect(service.transport.status().active).toBe(true);
    expect((active as any).closeCount).toBe(0);
  } finally {
    service.state.db.query("DELETE FROM peers").run();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
