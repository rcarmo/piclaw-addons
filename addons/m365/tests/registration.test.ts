import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerM365 from "../index.ts";

test("registers the complete standalone tool, command, and skill surface", async () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const fake = {
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
  } as unknown as ExtensionAPI;

  registerM365(fake);

  expect(tools).toHaveLength(28);
  expect(tools).toContain("m365_teams_messages");
  expect(tools).toContain("m365_todo");
  expect(tools).toContain("m365_todo_lists");
  expect(tools).toContain("m365_todo_task");
  expect(tools).toContain("m365_todo_step");
  expect(new Set(tools).size).toBe(tools.length);
  expect(commands.sort()).toEqual(["m365-clear", "m365-status"]);

  const discovered = await handlers.get("resources_discover")?.();
  expect(discovered?.skillPaths).toHaveLength(12);
  expect(discovered.skillPaths.every((skillPath: string) => existsSync(skillPath))).toBe(true);
});
