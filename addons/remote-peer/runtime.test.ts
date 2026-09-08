import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closePeerService, getPeerService } from "./runtime-service.js";
test("startup contributes only Iroh chat transport, disabled until configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-runtime-"));
  const global = globalThis as any;
  const old = global.__piclaw_runtime;
  let registered: any;
  let routes = 0;
  global.__piclaw_runtime = {
    lifecycle: {
      version: 1,
      onShutdown: (handler: () => Promise<void>) => {
        global.__peerShutdown = handler;
        return () => {};
      },
    },
    messaging: {
      version: 1,
      getAddonDataDir: () => root,
      registerChatTransport: (t) => {
        registered = t;
        return () => {};
      },
      listAdvertisableAgents: async () => [],
      deliverPeerMessage: async () => ({}),
    },
    externalRoutes: {
      version: 1,
      register: () => {
        routes++;
      },
    },
  };
  try {
    await import("./runtime.ts?" + Date.now());
    expect(registered.id).toBe("remote-peer");
    expect(registered.kind).toBe("bang");
    expect(routes).toBe(0);
    expect(typeof global.__peerShutdown).toBe("function");
    expect(getPeerService().transport.status().active).toBe(false);
    expect((await registered.directory()).entries).toEqual([]);
  } finally {
    await closePeerService();
    delete global.__peerShutdown;
    global.__piclaw_runtime = old;
    rmSync(root, { recursive: true, force: true });
  }
});
