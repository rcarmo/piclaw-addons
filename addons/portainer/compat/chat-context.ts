/**
 * compat/chat-context.ts — Chat context shim for standalone addons.
 * Provides getChatJid() using AsyncLocalStorage, matching piclaw's core/chat-context.ts.
 */

import { AsyncLocalStorage } from "async_hooks";

interface ChatContext {
  chatJid: string;
  channel: string;
}

const storage = new AsyncLocalStorage<ChatContext>();

export async function withChatContext<T>(
  chatJid: string,
  channel: string,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ chatJid, channel }, fn);
}

export function getChatJid(defaultValue = "web:default"): string {
  return storage.getStore()?.chatJid ?? defaultValue;
}

export function getChatChannel(defaultValue = "web"): string {
  return storage.getStore()?.channel ?? defaultValue;
}
