import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetRemotePeerFoundationForTests } from "./foundation.js";
import { resetPairingServiceForTests } from "./pairing/runtime-service.js";
import { resetMessagingServiceForTests } from "./messaging/runtime-service.js";
import { resetRosterServiceForTests } from "./messaging/runtime-roster.js";
import { resetWorkServiceForTests } from "./work/runtime-service.js";

const roots: string[] = [];
const addonDir = dirname(fileURLToPath(import.meta.url));
let registrations: unknown[][] = [];

beforeEach(() => {
  registrations = [];
  const root = mkdtempSync(join(tmpdir(), "remote-peer-index-"));
  roots.push(root);
  (globalThis as any).__piclaw_runtime = {
    messaging: {
      version: 1,
      getAddonDataDir: () => root,
      listAdvertisableAgents: async () => [],
      resolveLocalTarget: async () => ({ status: "not_found" }),
      deliverPeerMessage: async () => { throw new Error("not used"); },
      registerChatTransport: () => () => {},
    },
    externalRoutes: { version: 1, register: () => () => {} },
  };
  (globalThis as any).__piclaw_registerAddonConfigApi = (...args: unknown[]) => {
    registrations.push(args);
    return "created";
  };
});

afterEach(() => {
  resetPairingServiceForTests();
  resetMessagingServiceForTests();
  resetRosterServiceForTests();
  resetWorkServiceForTests();
  resetRemotePeerFoundationForTests();
  delete (globalThis as any).__piclaw_runtime;
  delete (globalThis as any).__piclaw_registerAddonConfigApi;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeApi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const messages: any[] = [];
  return {
    tools,
    commands,
    handlers,
    messages,
    api: {
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      sendMessage(message: any) { messages.push(message); },
      on(name: string, handler: Function) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
    } as any,
  };
}

describe("remote-peer extension foundation", () => {
  test("registers config API and never exposes the private key", async () => {
    const mod = await import(`./index.ts?test=${Date.now()}`);
    expect(registrations).toHaveLength(2);
    const handlers = registrations.find(args => args[1] === "config")?.[2] as any;
    const state = await handlers.get();
    expect(state.identity.fingerprint).toHaveLength(20);
    expect(state.identity.private_key).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("private_key");
    expect(state.database.schema_version).toBe(6);

    const saved = await handlers.set({ enabled: true, instanceName: "Lab" });
    expect(saved.config).toMatchObject({ enabled: true, instanceName: "Lab" });
    expect(saved.identity.private_key).toBeUndefined();
    expect(typeof mod.default).toBe("function");
  });

  test("dashboard API is redacted and requires immutable/risk confirmations", async () => {
    await import(`./index.ts?dashboard=${Date.now()}`);
    const dashboard = registrations.find(args => args[1] === "dashboard")?.[2] as any;
    const state = await dashboard.get();
    expect(state.health.database).toBe("ok");
    expect(state.peers).toEqual([]);
    expect(state.pending).toEqual([]);
    expect(JSON.stringify(state)).not.toContain("private_key");
    expect(JSON.stringify(state)).not.toContain("target_chat_jid");
    expect(JSON.stringify(state)).not.toContain("reply_token");
    expect(JSON.stringify(state)).not.toContain("source_chat_jid");
    expect(JSON.stringify(state)).not.toContain("outbound_attachments");
    await expect(dashboard.set({ action: "revoke", peer: "missing", confirmation: "wrong" })).rejects.toThrow("Revocation requires");
    await expect(dashboard.set({ action: "rotate_identity", confirmation: "wrong" })).rejects.toThrow("Key rotation requires");
    await expect(dashboard.set({ action: "set_policy", peer: "missing", scope: "all-advertised", confirmation: "wrong" })).rejects.toThrow("Peer not found");
  });

  test("tool trust and policy actions require the same confirmations as Settings", async () => {
    const mod = await import(`./index.ts?confirm=${Date.now()}`);
    const fake = fakeApi();
    mod.default(fake.api);
    const tool = fake.tools.get("remote_peer");
    const accept = await tool.execute("call", { action: "accept_pair", request_id: "missing" });
    expect(accept.isError).toBe(true);
    expect(accept.content[0].text).toContain("fingerprint confirmation");
    const revoke = await tool.execute("call", { action: "revoke", peer: "missing" });
    expect(revoke.isError).toBe(true);
    expect(revoke.content[0].text).toContain("fingerprint confirmation");
    const files = await tool.execute("call", { action: "set_attachment_policy", peer: "missing", enabled: true });
    expect(files.isError).toBe(true);
    expect(files.content[0].text).toContain("Peer not found");
  });

  test("registers remote_peer status/identity tool and skill discovery", async () => {
    const mod = await import(`./index.ts?tool=${Date.now()}`);
    const fake = fakeApi();
    mod.default(fake.api);
    const tool = fake.tools.get("remote_peer");
    expect(tool).toBeDefined();
    const status = await tool.execute("call", { action: "status" });
    expect(status.content[0].text).toContain("foundation is ready");
    expect(status.details.identity.private_key).toBeUndefined();
    const identity = await tool.execute("call", { action: "identity" });
    expect(identity.details.identity.fingerprint).toHaveLength(20);
    expect(fake.commands.get("pair")).toBeDefined();
    expect(tool.parameters.properties.action.enum).toContain("directory");
    expect(tool.parameters.properties.action.enum).toContain("retry_message");
    expect(tool.parameters.properties.action.enum).toContain("set_attachment_policy");
    await fake.commands.get("pair").handler("list");
    expect(fake.messages.at(-1).content).toContain('"peers": []');

    const discovery = await fake.handlers.get("resources_discover")?.[0]?.();
    expect(discovery.skillPaths[0]).toEndWith("skills/remote-peer/SKILL.md");
  });

  test("Settings exposes MVP readiness, usable addresses, health, policies, and send test", () => {
    const source = readFileSync(join(addonDir, "web", "index.ts"), "utf8");
    for (const text of ["MVP readiness", "Agent-ready addresses", "Test endpoint", "Send test", "Media ID (optional)", "Ping", "Roster", "ALLOW FILE TRANSFER", "Allowed aliases", "Allow auto", "Delivery retried", "failed delivery receipt"]) {
      expect(source).toContain(text);
    }
    expect(source).toContain('action: "set_attachment_policy"');
    expect(source).toContain('action: "send_test"');
    expect(source).toContain('action: "endpoint_test"');
  });

  test("fails cleanly without Piclaw messaging API v1", async () => {
    delete (globalThis as any).__piclaw_runtime;
    const mod = await import(`./index.ts?missing=${Date.now()}`);
    const fake = fakeApi();
    mod.default(fake.api);
    const result = await fake.tools.get("remote_peer").execute("call", { action: "status" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("messaging API v1");
  });
});
