import { AsyncLocalStorage } from "node:async_hooks";
import type { KeychainEntry, KeychainEntryMetadata } from "./compat/keychain.js";
import type { CurlExecutor } from "./client.js";

export interface ProxmoxInvocationOptions {
  chatJid: string;
  assertCurrent(): void;
  transport?: CurlExecutor;
  credentials?: {
    get(name: string): Promise<KeychainEntry>;
    list(): KeychainEntryMetadata[];
  };
}
interface Invocation extends ProxmoxInvocationOptions { check(): void }
const scope = new AsyncLocalStorage<Invocation>();
export function currentInvocation() { return scope.getStore(); }
export function assertInvocationCurrent(): void { scope.getStore()?.check(); }
export async function withInvocation<T>(options: ProxmoxInvocationOptions, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  if (!options.chatJid?.trim() || typeof options.assertCurrent !== "function") throw Error("Explicit invocation authority and chatJid required");
  let finished = false;
  const invocation = { ...options, check() {
    if (finished) throw Error("Invocation has finished");
    signal?.throwIfAborted();
    options.assertCurrent();
  } };
  return scope.run(invocation, async () => {
    try { invocation.check(); const result = await run(); invocation.check(); return result; }
    finally { finished = true; }
  });
}

/** Close an attempt independently of its parent when a timeout wins the race. */
export async function withInvocationAttempt<T>(start: () => Promise<T>, settle: (pending: Promise<T>) => Promise<T>): Promise<T> {
  const parent = currentInvocation();
  if (!parent) return settle(start());
  let closed = false;
  const child: Invocation = { ...parent, check() {
    parent.check();
    if (closed) throw Error("Invocation attempt has finished");
  } };
  try {
    return await scope.run(child, () => { child.check(); return settle(start()); });
  } finally { closed = true; }
}
