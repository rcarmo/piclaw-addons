import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closePeerService } from "./runtime-service.js";
test("direct settings API, client-ID tool and no peer HTTP route registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "iroh-settings-"));
  const global = globalThis as any;
  const oldRuntime = global.__piclaw_runtime,
    oldRegister = global.__piclaw_registerAddonConfigApi;
  const apis = new Map();
  const tools = new Map();
  let transports = 0,
    routes = 0;
  global.__piclaw_runtime = {
    messaging: {
      version: 1,
      getAddonDataDir: () => root,
      registerChatTransport: () => {
        transports++;
        return () => transports--;
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
  global.__piclaw_registerAddonConfigApi = (
    _id: string,
    action: string,
    handlers: any,
  ) => apis.set(action, handlers);
  try {
    const mod = await import("./index.ts?settings=" + Date.now());
    mod.default({
      on: () => {},
      registerTool: (t) => tools.set(t.name, t),
    } as any);
    const config = await apis.get("config").get();
    expect(config.config.enabled).toBe(false);
    expect(config.config.mdnsEnabled).toBe(false);
    expect(config.identity.clientId).toStartWith("PCL1-");
    expect(JSON.stringify(config)).not.toContain("keyBytes");
    expect(routes).toBe(0);
    expect(transports).toBe(1);
    const dash = await apis.get("dashboard").get();
    expect(dash.candidates).toEqual([]);
    expect(dash.peers).toEqual([]);
    expect(dash.transport.active).toBe(false);
    const actions = tools.get("remote_peer").parameters.properties.action.enum;
    expect(actions).toContain("pair");
    expect(actions).not.toContain("pair_request");
    expect(
      tools.get("remote_peer").parameters.properties.client_id,
    ).toBeDefined();
    expect(
      readFileSync(join(import.meta.dir, "runtime.ts"), "utf8"),
    ).not.toContain("externalRoutes.register");
    await expect(
      apis.get("config").set({ externalUrl: "https://old" }),
    ).rejects.toThrow("Unknown");
  } finally {
    await closePeerService();
    global.__piclaw_runtime = oldRuntime;
    global.__piclaw_registerAddonConfigApi = oldRegister;
    rmSync(root, { recursive: true, force: true });
  }
});
