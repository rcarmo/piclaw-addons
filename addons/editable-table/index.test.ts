import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import editableTableAddon from "./index.ts";

test("editable_table opens a widget payload and returns guidance text", async () => {
  const tools = new Map<string, any>();
  editableTableAddon({
    on() {},
    registerTool(tool: any) { tools.set(tool.name, tool); },
  } as any);

  const tool = tools.get("editable_table");
  const widgetCalls: Array<{ key: string; content: string[]; options: any }> = [];
  const result = await tool.execute("tool-1", {
    markdown: `| Name | Role |\n| --- | --- |\n| Rui | User |`,
    title: "Review people",
  }, undefined, undefined, {
    hasUI: true,
    ui: {
      setWidget(key: string, content: string[], options: any) {
        widgetCalls.push({ key, content, options });
      },
    },
  });

  expect(result.content[0].text).toContain("Opened the editable table widget");
  expect(widgetCalls).toHaveLength(1);
  expect(widgetCalls[0]?.key).toContain("editable-table:");
  expect(widgetCalls[0]?.options).toMatchObject({
    extension: "editable-table",
    title: "Review people",
  });
  expect(widgetCalls[0]?.content[0]).toContain("| Name | Role |");
});

test("editable table web grid uses contenteditable cells instead of form fields", () => {
  const source = readFileSync(join(import.meta.dir, "web", "index.ts"), "utf8");

  expect(source).toContain('contenteditable="true"');
  expect(source).toContain("editableCellHtml");
  expect(source).not.toContain("contenteditable=\"plaintext-only\"");
  expect(source).not.toMatch(/<textarea\b|<input\b/i);
});

test("editable_table rejects invalid markdown tables", async () => {
  const tools = new Map<string, any>();
  editableTableAddon({
    on() {},
    registerTool(tool: any) { tools.set(tool.name, tool); },
  } as any);

  const tool = tools.get("editable_table");
  const result = await tool.execute("tool-2", {
    markdown: "not a table",
  }, undefined, undefined, {
    hasUI: true,
    ui: { setWidget() {} },
  });

  expect(result.content[0].text).toContain("Could not open editable table widget");
  expect(result.details.reason).toBe("invalid_markdown_table");
});
