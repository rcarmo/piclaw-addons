import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetRemotePeerFoundationForTests } from "./foundation.js";

const roots: string[] = [];
let registrations: unknown[][] = [];

beforeEach(() => {
  registrations = [];
  const root = mkdtempSync(join(tmpdir(), "remote-peer-index-"));
  roots.push(root);
  (globalThis as any).__piclaw_runtime = {
    messaging: {
      version: 1,
      getAddonDataDir: () => root,
    },
    externalRoutes: { version: 1, register: () => () => {} },
  };
  (globalThis as any).__piclaw_registerAddonConfigApi = (...args: unknown[]) => {
    registrations.push(args);
    return "created";
  };
});

afterEach(() => {
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
    expect(registrations).toHaveLength(1);
    const handlers = registrations[0][2] as any;
    const state = await handlers.get();
    expect(state.identity.fingerprint).toHaveLength(20);
    expect(state.identity.private_key).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("private_key");
    expect(state.database.schema_version).toBe(2);

    const saved = await handlers.set({ enabled: true, instanceName: "Lab" });
    expect(saved.config).toMatchObject({ enabled: true, instanceName: "Lab" });
    expect(saved.identity.private_key).toBeUndefined();
    expect(typeof mod.default).toBe("function");
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
    await fake.commands.get("pair").handler("list");
    expect(fake.messages.at(-1).content).toContain('"peers": []');

    const discovery = await fake.handlers.get("resources_discover")?.[0]?.();
    expect(discovery.skillPaths[0]).toEndWith("skills/remote-peer/SKILL.md");
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
