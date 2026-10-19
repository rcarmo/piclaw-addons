/**
 * compat/extension-kv.ts — Extension KV store client for standalone addons.
 *
 * Accesses piclaw's global extension KV store singleton when running inside
 * the piclaw runtime. Requires the authoritative runtime store.
 *
 * Extensions use this through scoped wrappers that bind the extension ID.
 */

export type KvScope = "chat" | "global";

export interface ExtensionStorage {
  get<T = unknown>(key: string, scope?: KvScope, scopeKey?: string): T | null;
  set(key: string, value: unknown, scope?: KvScope, scopeKey?: string): void;
  delete(key: string, scope?: KvScope, scopeKey?: string): boolean;
  list(prefix?: string, scope?: KvScope, scopeKey?: string): string[];
  clear(scope?: KvScope, scopeKey?: string): number;
}

// ── Runtime-backed storage ───────────────────────────────────────

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

// ── Factory ──────────────────────────────────────────────────────

function getRuntimeInterop(): { getExtensionKvStore?: () => RuntimeKvStore } | null {
  const interop = (globalThis as { __piclawRuntimeInterop?: { getExtensionKvStore?: () => RuntimeKvStore } }).__piclawRuntimeInterop;
  return interop || null;
}

/**
 * Try to resolve piclaw's runtime KV store through the supported runtime bridge.
 * Do not import piclaw runtime internals from add-ons; standalone/test runs must provide an explicit runtime bridge.
 */
function tryGetRuntimeStore(): RuntimeKvStore | null {
  try {
    const interop = getRuntimeInterop();
    if (typeof interop?.getExtensionKvStore === "function") {
      return interop.getExtensionKvStore();
    }
  } catch {
    // Not running inside piclaw — use fallback.
  }
  return null;
}

/**
 * Create a scoped ExtensionStorage for the given extension ID.
 * If running inside piclaw, uses the DB-backed store.
 * Otherwise fails closed.
 */
export function createExtensionStorage(extensionId: string): ExtensionStorage {
  const runtimeStore = tryGetRuntimeStore();
  if (runtimeStore) {
    return new RuntimeBackedStorage(extensionId, runtimeStore);
  }
  throw new Error("Authoritative runtime extension KV required");
}
