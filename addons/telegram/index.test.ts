import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const previousRegistrar = (globalThis as any).__piclaw_registerAddonConfigApi;
const registrations: any[] = [];
(globalThis as any).__piclaw_registerAddonConfigApi = (...args: any[]) => { registrations.push(args); return "created"; };
const mod = await import(`./index.ts?test=${Date.now()}`);

afterEach(() => {
  delete (globalThis as any).__piclawRuntimeInterop;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.PICLAW_TELEGRAM_BOT_TOKEN;
});

test("manifest declares the supported Piclaw version range", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
  expect(manifest.piclaw.compatibleVersions).toBe(">=2.0.0");
});

test("registers the current module-scope config API contract", () => {
  expect(registrations).toHaveLength(1);
  const [addonId, action, handlers, extensionPath] = registrations[0];
  expect(addonId).toBe("telegram");
  expect(action).toBe("config");
  expect(typeof handlers.get).toBe("function");
  expect(typeof handlers.set).toBe("function");
  expect(extensionPath).toBe(import.meta.dir);
});

test("stores only non-secret settings in extension KV", () => {
  const writes: any[] = [];
  const values = new Map<string, unknown>();
  (globalThis as any).__piclawRuntimeInterop = {
    getExtensionKvStore: () => ({
      get: (_addon: string, key: string) => values.get(key) ?? null,
      set: (addon: string, key: string, value: unknown) => { writes.push([addon, key, value]); values.set(key, value); },
    }),
  };
  const result = mod.handleSetConfig({ botToken: "must-not-enter-kv", enabled: true, pollingTimeout: 999 });
  expect(writes).toEqual([
    ["telegram", "enabled", true],
    ["telegram", "pollingTimeout", 120],
  ]);
  expect(result).toMatchObject({ ok: true, enabled: true, pollingTimeout: 120, botTokenConfigured: false });
});

test("web pane saves the bot token through keychain", () => {
  const source = readFileSync(join(import.meta.dir, "web", "index.ts"), "utf8");
  expect(source).toContain('const BOT_TOKEN_KEYCHAIN = "telegram/bot-token"');
  expect(source).toContain('fetch("/agent/keychain"');
  expect(source).not.toContain("body.botToken");
});

if (previousRegistrar === undefined) delete (globalThis as any).__piclaw_registerAddonConfigApi;
else (globalThis as any).__piclaw_registerAddonConfigApi = previousRegistrar;
