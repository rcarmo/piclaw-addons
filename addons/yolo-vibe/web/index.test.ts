import { expect, test } from "bun:test";

import {
  buildAgentMessageRequest,
  normalizeChatJid,
  YOLO_VIBE_BUTTONS,
} from "./index.ts";

test("yolo-vibe defines the requested quick prompts", () => {
  expect(YOLO_VIBE_BUTTONS).toEqual([
    { id: "continue", label: "Continue", prompt: "continue" },
    { id: "audit", label: "Audit", prompt: "audit for code smells and logic errors, fixing as you go" },
    { id: "docs", label: "Docs", prompt: "review and update all documentation, then commit and push" },
  ]);
});

test("normalizeChatJid falls back to web:default", () => {
  expect(normalizeChatJid(" web:addons ")).toBe("web:addons");
  expect(normalizeChatJid(" ")).toBe("web:default");
});

test("buildAgentMessageRequest posts to the current chat in auto mode", () => {
  const request = buildAgentMessageRequest("continue", "web:addons");
  expect(request.url).toBe("/agent/default/message?chat_jid=web%3Aaddons");
  expect(request.options.method).toBe("POST");
  expect(JSON.parse(request.options.body)).toEqual({ content: "continue", mode: "auto", media_ids: [] });
});
