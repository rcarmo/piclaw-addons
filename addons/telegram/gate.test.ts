import { expect, test } from "bun:test";
import { evaluateUpdate, isDedicatedChatJid, parseAllowedUserIds } from "./gate.js";

const OPERATOR = 111222333;
const allowed = new Set([String(OPERATOR)]);
const ACTIVATED = 1_000;

function update(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 5,
      date: ACTIVATED + 1,
      from: { id: OPERATOR, is_bot: false, first_name: "Op" },
      chat: { id: OPERATOR, type: "private" },
      text: "hello",
      ...message,
    },
    ...extra,
  };
}

test("accepts plain text from an allowlisted user in their private chat", () => {
  expect(evaluateUpdate(update({}), allowed, ACTIVATED)).toEqual({ kind: "accept", chatId: OPERATOR, userId: String(OPERATOR), text: "hello" });
});

test("fails closed when the allowlist is empty", () => {
  expect(evaluateUpdate(update({}), new Set(), ACTIVATED).kind).toBe("ignore");
});

test.each([
  ["unknown sender", { from: { id: 999, is_bot: false }, chat: { id: 999, type: "private" } }],
  ["allowlisted user in a group", { chat: { id: -100123, type: "group" } }],
  ["allowlisted user in a forum topic", { chat: { id: -100123, type: "supergroup", is_forum: true }, message_thread_id: 7 }],
  ["bot sender", { from: { id: OPERATOR, is_bot: true } }],
  ["missing is_bot flag", { from: { id: OPERATOR } }],
  ["missing sender", { from: undefined }],
  ["sender chat (anonymous admin/channel)", { sender_chat: { id: -100555, type: "channel" } }],
  ["forwarded message", { forward_origin: { type: "user", date: 1 } }],
  ["legacy forward fields", { forward_from: { id: 5, is_bot: false } }],
  ["edited message body", { edit_date: ACTIVATED + 2 }],
  ["message older than activation", { date: ACTIVATED - 1 }],
  ["private chat id differing from sender", { chat: { id: 444, type: "private" } }],
])("ignores %s", (_label, message) => {
  expect(evaluateUpdate(update(message as Record<string, unknown>), allowed, ACTIVATED).kind).toBe("ignore");
});

test("ignores edited_message and channel_post updates", () => {
  const { message } = update({});
  expect(evaluateUpdate({ update_id: 2, edited_message: message }, allowed, ACTIVATED).kind).toBe("ignore");
  expect(evaluateUpdate({ update_id: 3, channel_post: message }, allowed, ACTIVATED).kind).toBe("ignore");
  expect(evaluateUpdate({ update_id: 4, message, edited_message: message }, allowed, ACTIVATED).kind).toBe("ignore");
});

test("refuses commands and mentions instead of queueing them", () => {
  expect(evaluateUpdate(update({ text: "/start" }), allowed, ACTIVATED)).toEqual({ kind: "start", chatId: OPERATOR });
  expect(evaluateUpdate(update({ text: "  /model gpt" }), allowed, ACTIVATED)).toEqual({ kind: "command", chatId: OPERATOR });
  expect(evaluateUpdate(update({ text: "@other do this" }), allowed, ACTIVATED)).toEqual({ kind: "command", chatId: OPERATOR });
  expect(evaluateUpdate(update({ text: "!echo hello" }), allowed, ACTIVATED)).toEqual({ kind: "command", chatId: OPERATOR });
});

test("answers allowlisted non-text messages but not strangers", () => {
  expect(evaluateUpdate(update({ text: undefined, photo: [{}] }), allowed, ACTIVATED)).toEqual({ kind: "unsupported", chatId: OPERATOR });
  expect(evaluateUpdate(update({ text: undefined, photo: [{}], from: { id: 9, is_bot: false }, chat: { id: 9, type: "private" } }), allowed, ACTIVATED).kind).toBe("ignore");
});

test("parses allowlists strictly", () => {
  expect(parseAllowedUserIds("123, 456 123")).toEqual(["123", "456"]);
  expect(parseAllowedUserIds([123, "456"])).toEqual(["123", "456"]);
  expect(parseAllowedUserIds("")).toEqual([]);
  expect(parseAllowedUserIds("123,abc")).toBeNull();
  expect(parseAllowedUserIds("-100123")).toBeNull();
  expect(parseAllowedUserIds("0")).toBeNull();
});

test("only dedicated web chats are valid targets", () => {
  expect(isDedicatedChatJid("web:telegram")).toBeTrue();
  expect(isDedicatedChatJid("web:default")).toBeFalse();
  expect(isDedicatedChatJid("telegram:123")).toBeFalse();
  expect(isDedicatedChatJid("web:")).toBeFalse();
});
