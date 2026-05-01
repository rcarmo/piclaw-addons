import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type KvScope = "chat" | "global";

class MockKvStore {
  values = new Map<string, string>();
  k(extensionId: string, key: string, scope?: KvScope, scopeKey?: string): string {
    return `${extensionId}\0${scope || "chat"}\0${scopeKey || ""}\0${key}`;
  }
  get<T>(extensionId: string, key: string, scope?: KvScope, scopeKey?: string): T | null {
    const value = this.values.get(this.k(extensionId, key, scope, scopeKey));
    return value ? JSON.parse(value) as T : null;
  }
  set(extensionId: string, key: string, value: unknown, scope?: KvScope, scopeKey?: string): void {
    this.values.set(this.k(extensionId, key, scope, scopeKey), JSON.stringify(value));
  }
  delete(extensionId: string, key: string, scope?: KvScope, scopeKey?: string): boolean {
    return this.values.delete(this.k(extensionId, key, scope, scopeKey));
  }
  list(extensionId: string, prefix = "", scope?: KvScope, scopeKey?: string): string[] {
    const base = `${extensionId}\0${scope || "chat"}\0${scopeKey || ""}\0`;
    return [...this.values.keys()]
      .filter((key) => key.startsWith(base))
      .map((key) => key.slice(base.length))
      .filter((key) => key.startsWith(prefix))
      .sort();
  }
  clear(extensionId: string, scope?: KvScope, scopeKey?: string): number {
    const base = `${extensionId}\0${scope || "chat"}\0${scopeKey || ""}\0`;
    let deleted = 0;
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(base)) {
        this.values.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

const kvStore = new MockKvStore();
const keychain = new Map<string, { name: string; type: string; secret: string; username?: string }>();

(globalThis as any).__piclawRuntimeInterop = {
  getExtensionKvStore: () => kvStore,
  getKeychainEntry: async (name: string) => {
    const entry = keychain.get(name);
    if (!entry) throw new Error(`missing keychain entry: ${name}`);
    return entry;
  },
  setKeychainEntry: async (entry: { name: string; type: string; secret: string; username?: string }) => {
    keychain.set(entry.name, { ...entry, secret: String(entry.secret) });
  },
  deleteKeychainEntry: async (name: string) => keychain.delete(name),
  listKeychainEntries: async () => [...keychain.values()].map(({ name, type }) => ({ name, type })),
};

const store = await import("./account-store.ts");

describe("IMAP account store", () => {
  test("uses runtime interop instead of spawning the piclaw CLI", () => {
    const source = readFileSync(resolve(import.meta.dir, "account-store.ts"), "utf8");
    expect(source).not.toContain("Bun.spawn");
    expect(source).not.toContain("piclaw keychain");
    expect(source).toContain("getKeychainEntry");
  });

  test("preserves raw password strings that look like JSON scalars", async () => {
    const saved = await store.saveAccount("Jsonish", {
      host: "imap.example.com",
      port: 993,
      user: "rui@example.com",
      tls: true,
      starttls: false,
    }, "true", true);

    expect(saved.name).toBe("jsonish");
    expect(saved.hasPassword).toBe(true);

    const account = await store.getAccount("Jsonish");
    expect(account?.password).toBe("true");
    expect(account?.hasPassword).toBe(true);
  });

  test("still reads legacy JSON keychain account blobs", async () => {
    keychain.set("imap/legacytest", {
      name: "imap/legacytest",
      type: "secret",
      secret: JSON.stringify({
        host: "legacy.example.com",
        port: 143,
        user: "legacy@example.com",
        pass: "legacy-pass",
        tls: false,
        starttls: true,
      }),
    });

    const account = await store.getAccount("legacytest");
    expect(account?.source).toBe("legacy-keychain");
    expect(account?.password).toBe("legacy-pass");
    expect(account?.starttls).toBe(true);
  });

  test("does not persist metadata if keychain write fails", async () => {
    const originalInterop = (globalThis as any).__piclawRuntimeInterop;
    (globalThis as any).__piclawRuntimeInterop = {
      ...originalInterop,
      setKeychainEntry: async () => { throw new Error("keychain unavailable"); },
    };

    await expect(store.saveAccount("PartialFailure", {
      host: "partial.example.com",
      port: 993,
      user: "partial@example.com",
      tls: true,
      starttls: false,
    }, "secret")).rejects.toThrow(/keychain unavailable/);

    (globalThis as any).__piclawRuntimeInterop = originalInterop;
    const account = await store.getAccount("PartialFailure");
    expect(account).toBeNull();
  });
});
