import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const previousRegistrar = (globalThis as any).__piclaw_registerAddonConfigApi;
const registrations: any[] = [];
(globalThis as any).__piclaw_registerAddonConfigApi = (...args: any[]) => { registrations.push(args); return "created"; };
const mod = await import(`./index.ts?test=${Date.now()}`);

afterEach(() => {
  delete (globalThis as any).__piclawRuntimeInterop;
  delete process.env.PICLAW_WHATSAPP_PHONE;
  delete process.env.PICLAW_WHATSAPP_ENABLED;
});

test("manifest declares the supported Piclaw version range", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
  expect(manifest.piclaw.compatibleVersions).toBe(">=2.0.0");
});

test("registers the current module-scope config API contract", () => {
  expect(registrations).toHaveLength(1);
  const [addonId, action, handlers, extensionPath] = registrations[0];
  expect(addonId).toBe("whatsapp");
  expect(action).toBe("config");
  expect(typeof handlers.get).toBe("function");
  expect(typeof handlers.set).toBe("function");
  expect(extensionPath).toBe(import.meta.dir);
});

test("persists non-secret WhatsApp settings through runtime KV", () => {
  const values = new Map<string, unknown>();
  (globalThis as any).__piclawRuntimeInterop = {
    getExtensionKvStore: () => ({
      get: (_addon: string, key: string) => values.get(key) ?? null,
      set: (_addon: string, key: string, value: unknown) => values.set(key, value),
    }),
  };
  const result = mod.handleSetConfig({ phone: " +351 123 ", enabled: true });
  expect(values.get("phone")).toBe("+351 123");
  expect(values.get("enabled")).toBe(true);
  expect(result).toMatchObject({ ok: true, phone: "+351 123", enabled: true, connected: false, pairingCode: null });
});

if (previousRegistrar === undefined) delete (globalThis as any).__piclaw_registerAddonConfigApi;
else (globalThis as any).__piclaw_registerAddonConfigApi = previousRegistrar;
