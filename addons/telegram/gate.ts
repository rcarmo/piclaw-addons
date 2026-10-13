/**
 * gate.ts — Pure inbound authorisation for the Telegram channel.
 *
 * The gate fails closed: only plain new text messages from an allowlisted,
 * non-bot user in that user's own private chat are accepted. Everything else
 * is ignored without a reply, so strangers learn nothing about the bot.
 */

const TELEGRAM_USER_ID_PATTERN = /^[1-9][0-9]{0,15}$/;
export const MAX_INBOUND_TEXT_BYTES = 16_000;
const FORWARD_KEYS = ["forward_origin", "forward_from", "forward_from_chat", "forward_sender_name", "forward_date"];

export type GateDecision =
  | { kind: "ignore" }
  | { kind: "accept"; chatId: number; userId: string; text: string }
  | { kind: "start"; chatId: number }
  | { kind: "command"; chatId: number }
  | { kind: "unsupported"; chatId: number };

export function isTelegramUserId(value: unknown): value is string {
  return typeof value === "string" && TELEGRAM_USER_ID_PATTERN.test(value) && Number.isSafeInteger(Number(value));
}

/** Accepts an array or a comma/whitespace separated string; returns null if any entry is invalid. */
export function parseAllowedUserIds(value: unknown): string[] | null {
  const items = Array.isArray(value)
    ? value.map((item) => (typeof item === "number" ? String(item) : item))
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : null;
  if (!items) return null;
  const ids: string[] = [];
  for (const item of items) {
    const trimmed = typeof item === "string" ? item.trim() : item;
    if (trimmed === "") continue;
    if (!isTelegramUserId(trimmed)) return null;
    if (!ids.includes(trimmed)) ids.push(trimmed);
  }
  return ids;
}

/** A dedicated local web chat; the shared default chat is never a valid target. */
export function isDedicatedChatJid(value: unknown): value is string {
  return typeof value === "string" && /^web:\S+$/.test(value) && value !== "web:default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function evaluateUpdate(update: unknown, allowedUserIds: ReadonlySet<string>, activatedAtSeconds: number): GateDecision {
  const ignore: GateDecision = { kind: "ignore" };
  if (allowedUserIds.size === 0 || !isRecord(update)) return ignore;
  // Only brand-new messages: edits, channel posts and every other update type are dropped.
  if (Object.keys(update).some((key) => key !== "update_id" && key !== "message")) return ignore;
  const message = update.message;
  if (!isRecord(message)) return ignore;

  const from = message.from;
  const chat = message.chat;
  if (!isRecord(from) || !isRecord(chat)) return ignore;
  if (from.is_bot !== false || !Number.isSafeInteger(from.id) || (from.id as number) <= 0) return ignore;
  const userId = String(from.id);
  if (!allowedUserIds.has(userId)) return ignore;
  if (chat.type !== "private" || chat.id !== from.id) return ignore;
  if ("sender_chat" in message || "edit_date" in message || FORWARD_KEYS.some((key) => key in message)) return ignore;
  // Messages sent before polling started (for example while Piclaw was down) are never replayed.
  if (!Number.isSafeInteger(message.date) || (message.date as number) < activatedAtSeconds) return ignore;

  const chatId = chat.id as number;
  if (typeof message.text !== "string") return { kind: "unsupported", chatId };
  const text = message.text;
  if (!text.trim() || Buffer.byteLength(text, "utf8") > MAX_INBOUND_TEXT_BYTES) return { kind: "unsupported", chatId };
  const command = text.trimStart();
  if (command.trimEnd() === "/start") return { kind: "start", chatId };
  // Slash commands and the `!` shell alias would run immediately; @mentions would route to other chats.
  if (/^[/!@]/.test(command)) return { kind: "command", chatId };
  return { kind: "accept", chatId, userId, text };
}
