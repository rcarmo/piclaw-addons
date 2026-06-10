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
    { id: "continue", label: "Continue", prompt: "continue, according to plan" },
    { id: "audit", label: "Audit", prompt: "audit for code smells and logic errors, fixing as you go" },
    { id: "docs", label: "Docs", prompt: "review and update all documentation, then commit and push" },
  ]);
});

test("normalizeChatJid falls back to web:default", () => {
  expect(normalizeChatJid(" web:addons ")).toBe("web:addons");
  expect(normalizeChatJid(" ")).toBe("web:default");
});

test("web entry mounts the quick buttons inside the compose action bar, bottom-aligned", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  // Anchored to the real compose DOM, inserted into the bottom action row.
  expect(source).toContain(`querySelector?.(".compose-input-wrapper")`);
  expect(source).toContain(`querySelector?.(".compose-actions")`);
  expect(source).toContain("point.actions.insertBefore(toolbar, point.actions.firstChild)");
  // No longer floated as a fixed element over the timeline.
  expect(source).not.toContain("position:fixed");
  expect(source).not.toContain("FLOATING_RIGHT_GUTTER_PX");
  expect(source).not.toContain("positionToolbar");
  expect(source).not.toContain("target.appendChild(toolbar)");
});

test("web entry keeps the buttons partially transparent until hover/focus", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  expect(source).toContain("opacity:.34");
  expect(source).toContain(".compose-input-wrapper:hover .${TOOLBAR_CLASS}");
  expect(source).toContain(".${TOOLBAR_CLASS}:focus-within{opacity:1}");
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
