/**
 * compat/extension-kv.ts — Extension KV store client for standalone addons.
 */

export type KvScope = "chat" | "global";

export interface ExtensionStorage {
  get<T = unknown>(key: string, scope?: KvScope, scopeKey?: string): T | null;
  set(key: string, value: unknown, scope?: KvScope, scopeKey?: string): void;
  delete(key: string, scope?: KvScope, scopeKey?: string): boolean;
  list(prefix?: string, scope?: KvScope, scopeKey?: string): string[];
  clear(scope?: KvScope, scopeKey?: string): number;
}

class InMemoryStorage implements ExtensionStorage {
  private store = new Map<string, string>();
  constructor(private extensionId: string) {}

  private k(key: string, scope?: KvScope, scopeKey?: string): string {
    return `${this.extensionId}\0${scope || "chat"}\0${scopeKey || ""}\0${key}`;
  }

  get<T = unknown>(key: string, scope?: KvScope, scopeKey?: string): T | null {
    const v = this.store.get(this.k(key, scope, scopeKey));
    return v ? JSON.parse(v) : null;
  }

  set(key: string, value: unknown, scope?: KvScope, scopeKey?: string): void {
    this.store.set(this.k(key, scope, scopeKey), JSON.stringify(value));
  }

  delete(key: string, scope?: KvScope, scopeKey?: string): boolean {
    return this.store.delete(this.k(key, scope, scopeKey));
  }

  list(prefix?: string, scope?: KvScope, scopeKey?: string): string[] {
    const base = `${this.extensionId}\0${scope || "chat"}\0${scopeKey || ""}\0`;
    const keys: string[] = [];
    for (const k of this.store.keys()) {
      if (!k.startsWith(base)) continue;
      const remainder = k.slice(base.length);
      if (!prefix || remainder.startsWith(prefix)) keys.push(remainder);
    }
    return keys.sort();
  }

  clear(scope?: KvScope, scopeKey?: string): number {
    const prefix = scopeKey
      ? `${this.extensionId}\0${scope || "chat"}\0${scopeKey}\0`
      : scope
        ? `${this.extensionId}\0${scope}\0`
        : `${this.extensionId}\0`;
    let count = 0;
    for (const key of [...this.store.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.store.delete(key);
      count += 1;
    }
    return count;
  }
}

interface RuntimeKvStore {
  get<T>(extensionId: string, key: string, scope?: KvScope, scopeKey?: string): T | null;
  set(extensionId: string, key: string, value: unknown, scope?: KvScope, scopeKey?: string): void;
  delete(extensionId: string, key: string, scope?: KvScope, scopeKey?: string): boolean;
  list(extensionId: string, prefix?: string, scope?: KvScope, scopeKey?: string): string[];
  clear(extensionId: string, scope?: KvScope, scopeKey?: string): number;
}

class RuntimeBackedStorage implements ExtensionStorage {
  constructor(private extensionId: string, private store: RuntimeKvStore) {}

  get<T = unknown>(key: string, scope?: KvScope, scopeKey?: string): T | null {
    return this.store.get<T>(this.extensionId, key, scope, scopeKey);
  }

  set(key: string, value: unknown, scope?: KvScope, scopeKey?: string): void {
    this.store.set(this.extensionId, key, value, scope, scopeKey);
  }

  delete(key: string, scope?: KvScope, scopeKey?: string): boolean {
    return this.store.delete(this.extensionId, key, scope, scopeKey);
  }

  list(prefix?: string, scope?: KvScope, scopeKey?: string): string[] {
    return this.store.list(this.extensionId, prefix, scope, scopeKey);
  }

  clear(scope?: KvScope, scopeKey?: string): number {
    return this.store.clear(this.extensionId, scope, scopeKey);
  }
}

function tryGetRuntimeStore(): RuntimeKvStore | null {
  try {
    const mod = require("piclaw/runtime/src/extension-kv-registry.js");
    if (typeof mod?.getExtensionKvStore === "function") {
      return mod.getExtensionKvStore();
    }
  } catch {}
  return null;
}

export function createExtensionStorage(extensionId: string): ExtensionStorage {
  const runtimeStore = tryGetRuntimeStore();
  if (runtimeStore) return new RuntimeBackedStorage(extensionId, runtimeStore);
  return new InMemoryStorage(extensionId);
}
