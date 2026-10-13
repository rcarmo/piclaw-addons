import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finalAssistantText } from "./index.js";
import type { SettingsContext } from "./service.js";

const SERVICE_KEY = Symbol.for("piclaw.addon.telegram.service");
const previousRegistrar = (globalThis as any).__piclaw_registerAddonConfigApi;
const registrations: any[] = [];
(globalThis as any).__piclaw_registerAddonConfigApi = (...args: any[]) => { registrations.push(args); return "created"; };
// Importing the startup entry without Piclaw's runtime API must not throw.
await import(`./runtime.ts?test=${Date.now()}`);

afterAll(() => {
  delete (globalThis as any)[SERVICE_KEY];
  if (previousRegistrar === undefined) delete (globalThis as any).__piclaw_registerAddonConfigApi;
  else (globalThis as any).__piclaw_registerAddonConfigApi = previousRegistrar;
});

test("manifest declares a startup runtime entry and the supported Piclaw range", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
  expect(manifest.piclaw.compatibleVersions).toBe(">=3.3.2");
  expect(manifest.pi.runtime).toEqual({ entries: ["runtime.ts"], load: "startup" });
  expect(manifest.dependencies?.grammy).toBe("1.46.0");
});

test("startup entry registers the module-scope config API and stays inactive without host APIs", async () => {
  expect(registrations).toHaveLength(1);
  const [addonId, action, handlers, extensionPath] = registrations[0];
  expect(addonId).toBe("telegram");
  expect(action).toBe("config");
  expect(typeof handlers.get).toBe("function");
  expect(typeof handlers.set).toBe("function");
  expect(extensionPath).toBe(import.meta.dir);
  const view = await handlers.get({}, new Request("http://localhost/"), null);
  expect(view).toMatchObject({ enabled: false, connected: false, botTokenKeychain: "telegram/bot-token", targets: [] });
  expect(view.status).toStartWith("Inactive");
});

test("final reply text skips failed attempts", () => {
  expect(finalAssistantText([{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "a" }, { type: "toolCall" }, { type: "text", text: "b" }], stopReason: "stop" }])).toBe("ab");
  expect(finalAssistantText([{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error" }])).toBeNull();
  expect(finalAssistantText([{ role: "assistant", content: [], stopReason: "aborted" }])).toBeNull();
  expect(finalAssistantText(undefined)).toBeNull();
});

test("web pane saves the bot token through keychain only", () => {
  const source = readFileSync(join(import.meta.dir, "web", "index.ts"), "utf8");
  expect(source).toContain('const BOT_TOKEN_KEYCHAIN = "telegram/bot-token"');
  expect(source).toContain('fetch("/agent/keychain"');
  expect(source).not.toContain("botToken:");
  expect(source).toContain("allowedUserIds");
  expect(source).toContain("targetChatJid");
});

function configFixture() {
  const store = new Map<string, unknown>();
  const previous = (globalThis as any).__piclawRuntimeInterop;
  (globalThis as any).__piclawRuntimeInterop = {
    getExtensionKvStore: () => ({
      get: (_addon: string, key: string) => store.get(key),
      set: (_addon: string, key: string, value: unknown) => store.set(key, value),
    }),
  };
  const targets = [
    { chatJid: "web:sibling-a", incarnation: "branch-aaaaaaaa", label: "same-agent" },
    { chatJid: "web:sibling-b", incarnation: "branch-bbbbbbbb", label: "same-agent" },
  ];
  const context: SettingsContext = {
    listTargets: async () => targets,
    resolveTarget: async (target) => targets.find((candidate) => candidate.chatJid === target.chatJid && candidate.incarnation === target.incarnation) ?? null,
  };
  return { store, targets, context, handlers: registrations[0][2], restore: () => {
    if (previous === undefined) delete (globalThis as any).__piclawRuntimeInterop;
    else (globalThis as any).__piclawRuntimeInterop = previous;
  } };
}

test("config GET lists both same-agent sibling lifetimes; POST validates and stores each", async () => {
  const f = configFixture();
  try {
    const get = await f.handlers.get(null, new Request("http://localhost/"), f.context);
    expect(get.targets).toEqual(f.targets);
    for (const target of f.targets) {
      const response = await f.handlers.set({ enabled: true, targetChatJid: target.chatJid, targetIncarnation: target.incarnation }, new Request("http://localhost/", { method: "POST" }), f.context);
      expect(response).toMatchObject({ ok: true, targetChatJid: target.chatJid, targetIncarnation: target.incarnation });
      expect(f.store.get("settings")).toMatchObject({ targetChatJid: target.chatJid, targetIncarnation: target.incarnation });
    }
  } finally { f.restore(); }
});

test("config POST without local request context rejects a material save", async () => {
  const f = configFixture();
  try {
    await expect(f.handlers.set({ pollingTimeout: 45 }, new Request("http://localhost/", { method: "POST" }), null)).rejects.toThrow("Verified local context unavailable");
    expect(f.store.has("settings")).toBeFalse();
  } finally { f.restore(); }
});

test("config POST rejects a stale incarnation and preserves stored settings", async () => {
  const f = configFixture();
  try {
    const target = f.targets[0];
    const stored = { enabled: true, allowedUserIds: ["111222333"], targetChatJid: target.chatJid, targetIncarnation: target.incarnation, pollingTimeout: 30 };
    f.store.set("settings", stored);
    await expect(f.handlers.set({ targetChatJid: target.chatJid, targetIncarnation: "deleted-branch" }, new Request("http://localhost/", { method: "POST" }), f.context)).rejects.toThrow("stale or unavailable");
    await expect(f.handlers.set({ targetChatJid: target.chatJid, targetIncarnation: "" }, new Request("http://localhost/", { method: "POST" }), f.context)).rejects.toThrow("current target chat lifetime");
    expect(f.store.get("settings")).toEqual(stored);
  } finally { f.restore(); }
});

test("picker persists lifetimes, distinguishes sibling branches and shows server save errors", () => {
  const source = readFileSync(join(import.meta.dir, "web", "index.ts"), "utf8");
  expect(source).toContain("JSON.stringify([t.chatJid, t.incarnation])");
  expect(source).toContain("t.incarnation.slice(0, 8)");
  expect(source).toContain("targetIncarnation, pollingTimeout");
  expect(source).toContain('throw new Error(data.error ||');
});
