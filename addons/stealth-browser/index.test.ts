import { expect, test } from "bun:test";

import register from "./index.js";

test("uses current schema and lifecycle contracts", () => {
  let tool: any;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  register({
    registerTool(value: unknown) { tool = value; },
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
  } as any);

  expect(tool.parameters.properties.action.enum).toEqual([
    "goto", "click", "type", "scroll", "screenshot", "evaluate",
    "text", "fetch", "cookies", "status", "close",
  ]);
  expect(handlers.has("session_shutdown")).toBeTrue();
});

test("tool results include required details", async () => {
  let tool: any;
  register({ registerTool(value: unknown) { tool = value; }, on() {} } as any);
  expect(await tool.execute("call", { action: "status" })).toEqual({
    content: [{ type: "text", text: "No active stealth browser session." }],
    details: {},
  });
});
