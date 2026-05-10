import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

test("web entry floats the toolbar over the timeline without taking compose space", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  expect(source).toContain(`.${"${TOOLBAR_CLASS}"}{position:fixed`);
  expect(source).toContain("target.appendChild(toolbar)");
  expect(source).toContain("wrapperRect.right - toolbarWidth");
  expect(source).toContain("composeRect.top - toolbarHeight - 6");
  expect(source).toContain("point.composeBox.classList.remove(HOST_CLASS)");
  expect(source).not.toContain("point.composeBox.insertBefore(toolbar, point.wrapper)");
  expect(source).not.toContain("point.sessionGroup.appendChild(toolbar)");
  expect(source).not.toContain("position:absolute;top:0;right:calc(100% + 6px)");
  expect(source).not.toContain("max-width:none");
  expect(source).not.toContain("insertBefore(toolbar, point.inputMain)");
});

test("web entry uses flat host styling without shadows or gradients", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  expect(source).not.toContain("box-shadow");
  expect(source).not.toContain("linear-gradient");
  expect(source).not.toContain("color-mix");
});

test("buildAgentMessageRequest posts to the current chat in auto mode", () => {
  const request = buildAgentMessageRequest("continue", "web:addons");
  expect(request.url).toBe("/agent/default/message?chat_jid=web%3Aaddons");
  expect(request.options.method).toBe("POST");
  expect(JSON.parse(request.options.body)).toEqual({ content: "continue", mode: "auto", media_ids: [] });
});
