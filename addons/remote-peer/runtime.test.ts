import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetRemotePeerFoundationForTests } from "./foundation.js";
import { resetMessagingServiceForTests } from "./messaging/runtime-service.js";
import { resetPairingServiceForTests } from "./pairing/runtime-service.js";

const roots: string[] = [];

afterEach(() => {
  resetPairingServiceForTests();
  resetMessagingServiceForTests();
  resetRemotePeerFoundationForTests();
  delete (globalThis as any).__piclaw_runtime;
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

test("startup registers the bang transport and signed external route", async () => {
  const root = mkdtempSync(join(tmpdir(), "remote-peer-runtime-"));
  roots.push(root);
  const transports: any[] = [];
  const routes: any[] = [];
  (globalThis as any).__piclaw_runtime = {
    messaging: {
      version: 1,
      getAddonDataDir: () => root,
      registerChatTransport: (transport: any) => { transports.push(transport); return () => {}; },
      listAdvertisableAgents: async () => [],
      resolveLocalTarget: async () => ({ status: "not_found" }),
      deliverPeerMessage: async () => { throw new Error("not used"); },
    },
    externalRoutes: {
      version: 1,
      register: (registration: any) => { routes.push(registration); return () => {}; },
    },
  };

  await import(`./runtime.ts?test=${Date.now()}`);
  expect(transports).toHaveLength(1);
  expect(transports[0]).toMatchObject({ id: "remote-peer", kind: "bang" });
  expect(typeof transports[0].send).toBe("function");
  expect(routes).toHaveLength(1);
  expect(routes[0]).toMatchObject({
    addonId: "remote-peer",
    prefix: "/api/addons/remote-peer/v1",
    methods: ["POST"],
    maxBodyBytes: 32 * 1024,
  });
  expect(typeof routes[0].handler).toBe("function");
});

test("startup attaches messaging when the session extension initialized pairing first", async () => {
  const root = mkdtempSync(join(tmpdir(), "remote-peer-runtime-order-"));
  roots.push(root);
  const routes: any[] = [];
  const runtime = {
    messaging: {
      version: 1,
      getAddonDataDir: () => root,
      registerChatTransport: () => () => {},
      listAdvertisableAgents: async () => [],
      resolveLocalTarget: async () => ({ status: "not_found" }),
      deliverPeerMessage: async () => { throw new Error("not used"); },
    },
    externalRoutes: {
      version: 1,
      register: (registration: any) => { routes.push(registration); return () => {}; },
    },
  };
  (globalThis as any).__piclaw_runtime = runtime;
  const { getRemotePeerFoundation } = await import("./foundation.js");
  const { getPairingService } = await import("./pairing/runtime-service.js");
  const foundation = getRemotePeerFoundation(root);
  foundation.saveConfig({ ...foundation.loadConfig(), enabled: true });
  getPairingService(foundation);

  await import(`./runtime.ts?order=${Date.now()}`);
  expect(routes).toHaveLength(1);
  const response = await routes[0].handler(
    new Request("http://local.test/api/addons/remote-peer/v1/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
    "/api/addons/remote-peer/v1/message",
  );
  expect(response.status).not.toBe(503);
});
