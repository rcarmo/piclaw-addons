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

  test("ignores old combined keychain account blobs", async () => {
    keychain.set("imap/oldstyle", {
      name: "imap/oldstyle",
      type: "secret",
      secret: JSON.stringify({
        host: "old.example.com",
        port: 143,
        user: "old@example.com",
        pass: "old-pass",
        tls: false,
        starttls: true,
      }),
    });

    const listed = await store.listAccounts();
    expect(listed.accounts.some((account) => account.name === "oldstyle")).toBe(false);
    await expect(store.getAccount("oldstyle")).resolves.toBeNull();
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

 test("native mailbox action parity with synthetic clients only", async () => {
  const { createImapTool, ImapPool } = await import("./index.ts");
  const { ImapClient } = await import("./imap-client.ts");
  await store.saveAccount("native-fixture", { host: "synthetic.invalid", user: "fixture", tls: true }, "fixture");
  const calls: string[] = [];
  const pool = new ImapPool(() => new Proxy({ dispose() { calls.push("dispose"); } }, {
    get(target, key) {
      if (key === "then") return undefined;
      if (key === "dispose") return target.dispose;
      return async () => { calls.push(String(key)); return key === "fetchSource" ? "fixture body" : []; };
    },
  }) as unknown as InstanceType<typeof ImapClient>);
  const tool = createImapTool({ assertCurrent() {}, chatJid: "fixture", pool });
  for (const action of ["list_folders", "search", "fetch", "move", "copy", "flag", "create_draft", "file_message", "create_folder", "delete_folder"]) {
    const result = await tool.execute("fixture", { action, account: "native-fixture", folder: "Fixture", targetFolder: "Other", uids: "1", flags: "\\Seen", draftSubject: "fixture", draftBody: "fixture", confirm: "true" });
    expect(result.content[0].type).toBe("text");
  }
  for (const action of ["list_accounts", "get_account", "set_default_account", "save_account", "delete_account"]) {
    const result = await tool.execute("fixture", { action, account: "native-fixture", host: "synthetic.invalid", user: "fixture", pass: "fixture", tls: "true" });
    expect(result.content[0].type).toBe("text");
  }
  expect(calls.filter(c => c === "dispose").length).toBe(10);
  pool.dispose();
});

for (const mode of ["revoked", "aborted"] as const) test(`credential await ${mode} prevents connection`, async () => {
  const { createImapTool, ImapPool } = await import("./index.ts");
  await store.saveAccount("await-fixture", { host: "synthetic.invalid", user: "fixture", tls: true }, "fixture");
  const original = (globalThis as any).__piclawRuntimeInterop;
  let resume!: () => void, entered!: () => void, current = true, connections = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const controller = new AbortController();
  const pool = new ImapPool(() => { connections++; throw Error("must not connect"); });
  (globalThis as any).__piclawRuntimeInterop = { ...original, async getKeychainEntry(name: string) {
    entered(); await gate; return original.getKeychainEntry(name);
  } };
  try {
    const pending = createImapTool({ pool, chatJid: "fixture", signal: controller.signal,
      assertCurrent() { if (!current) throw Error("revoked"); } }).execute("fixture", { action: "list_folders", account: "await-fixture" });
    await waiting;
    if (mode === "revoked") current = false; else controller.abort();
    resume();
    await expect(pending).rejects.toThrow(mode === "revoked" ? "revoked" : "aborted");
    expect(connections).toBe(0);
  } finally { resume(); pool.dispose(); (globalThis as any).__piclawRuntimeInterop = original; }
});

test("existing settings routes preserve CRUD, default and password redaction", async () => {
  const original = (globalThis as any).__piclaw_registerRoute;
  let handler!: (req: Request, path: string) => Promise<Response>;
  (globalThis as any).__piclaw_registerRoute = (_prefix: string, route: typeof handler) => { handler = route; return "created"; };
  try {
    (await import("./index.ts")).default({ registerTool() {} } as any);
    const request = async (path: string, method = "GET", body?: unknown) => {
      const full = "/imap-settings/api/" + path;
      const response = await handler(new Request("http://fixture.invalid" + full, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), full);
      return { response, body: await response.json() as any };
    };
    expect((await request("accounts/settings-fixture", "PUT", { host: "synthetic.invalid", user: "fixture", password: "fixture", setDefault: true })).body.ok).toBe(true);
    const loaded = await request("accounts/settings-fixture");
    expect(loaded.body.account.password).toBeUndefined(); expect(loaded.body.hasPassword).toBe(true);
    expect((await request("accounts")).body.defaultAccount).toBe("settings-fixture");
    expect((await request("default", "POST", { name: null })).body.defaultAccount).toBeNull();
    expect((await request("accounts/settings-fixture", "DELETE")).body.deleted).toBe(true);
    expect((await request("accounts/settings-fixture")).response.status).toBe(404);
  } finally { (globalThis as any).__piclaw_registerRoute = original; }
});

for (const source of ["options", "execute"] as const) test(`active ${source} abort disposes client and prevents login`, async () => {
  const { createImapTool, ImapPool } = await import("./index.ts");
  await store.saveAccount("abort-fixture", { host: "synthetic.invalid", user: "fixture", tls: true }, "fixture");
  let entered!: () => void, stop!: () => void, disposed = 0, logins = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { stop = resolve; });
  const pool = new ImapPool(() => ({ async connect() { entered(); await gate; }, async login() { logins++; }, dispose() { disposed++; stop(); } }) as any);
  const controller = new AbortController();
  const pending = createImapTool({ pool, chatJid: "fixture", assertCurrent() {}, ...(source === "options" ? { signal: controller.signal } : {}) })
    .execute("fixture", { action: "list_folders", account: "abort-fixture" }, source === "execute" ? controller.signal : undefined);
  await waiting; controller.abort();
  await expect(pending).rejects.toThrow("aborted");
  expect(disposed).toBeGreaterThan(0); expect(logins).toBe(0); pool.dispose();
});
