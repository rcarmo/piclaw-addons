/**
 * compat/chat-context.ts — Chat context shim for standalone addons.
 *
 * In Piclaw, addon modules are loaded outside the runtime source tree, so they
 * cannot import the runtime's AsyncLocalStorage singleton directly. When Piclaw
 * exposes __piclawRuntimeInterop.getChatJid/getChatChannel, prefer that active
 * runtime context; fall back to this local AsyncLocalStorage for standalone
 * tests and non-Piclaw hosts.
 */

import { AsyncLocalStorage } from "async_hooks";

interface ChatContext {
  chatJid: string;
  channel: string;
}

interface RuntimeInteropBridge {
  getChatJid?: (defaultValue?: string) => string;
  getChatChannel?: (defaultValue?: string) => string;
}

const storage = new AsyncLocalStorage<ChatContext>();

function runtimeInterop(): RuntimeInteropBridge | undefined {
  return (globalThis as { __piclawRuntimeInterop?: RuntimeInteropBridge }).__piclawRuntimeInterop;
}

function nonEmptyString(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

export async function withChatContext<T>(
  chatJid: string,
  channel: string,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ chatJid, channel }, fn);
}

export function getChatJid(defaultValue = "web:default"): string {
  const local = nonEmptyString(storage.getStore()?.chatJid);
  if (local) return local;
  try {
    return nonEmptyString(runtimeInterop()?.getChatJid?.(defaultValue)) || defaultValue;
  } catch {
    return defaultValue;
  }
}

export function getChatChannel(defaultValue = "web"): string {
  const local = nonEmptyString(storage.getStore()?.channel);
  if (local) return local;
  try {
    return nonEmptyString(runtimeInterop()?.getChatChannel?.(defaultValue)) || defaultValue;
  } catch {
    return defaultValue;
  }
}
