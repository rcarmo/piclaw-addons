import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeMarkdownTable, parseMarkdownTable } from "./shared.js";

const EXTENSION_ID = "editable-table";
const baseDir = dirname(fileURLToPath(import.meta.url));

const EditableTableSchema = Type.Object({
  markdown: Type.String({
    description: "Markdown table to open in the editable spreadsheet-style widget.",
  }),
  title: Type.Optional(Type.String({
    description: "Optional widget title.",
  })),
  instructions: Type.Optional(Type.String({
    description: "Optional helper text shown above the grid.",
  })),
});

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export default function editableTableAddon(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "skills", "editable-table", "SKILL.md")],
  }));

  pi.registerTool({
    name: "editable_table",
    label: "editable_table",
    description: "Open a themed spreadsheet-style widget for editing a Markdown table in the web UI.",
    promptSnippet: "editable_table: open a visual spreadsheet-style editor for a Markdown table; the user's final table comes back into chat as Markdown.",
    promptGuidelines: [
      "Use editable_table when the user needs to fill, correct, or review structured tabular data visually.",
      "Pass a valid Markdown table and then wait for the user's submitted Markdown table to come back into chat.",
    ],
    parameters: EditableTableSchema,
    async execute(_toolCallId, params, _signal, _update, ctx) {
      if (!ctx.hasUI) {
        return textResult("editable_table requires the interactive web UI.", { ok: false, reason: "no_ui" });
      }

      let normalizedMarkdown = "";
      let table;
      try {
        normalizedMarkdown = normalizeMarkdownTable(params.markdown);
        table = parseMarkdownTable(normalizedMarkdown);
      } catch (error) {
        return textResult(
          `Could not open editable table widget: ${error instanceof Error ? error.message : String(error)}`,
          { ok: false, reason: "invalid_markdown_table" },
        );
      }

      const title = typeof params.title === "string" && params.title.trim()
        ? params.title.trim()
        : "Edit table";
      const instructions = typeof params.instructions === "string" && params.instructions.trim()
        ? params.instructions.trim()
        : "Edit the table, then click Insert into chat to send the Markdown table back into the conversation.";

      ctx.ui.setWidget(`editable-table:${Date.now()}`, [normalizedMarkdown], {
        extension: EXTENSION_ID,
        surface: "floating-widget",
        title,
        instructions,
        markdown_table: normalizedMarkdown,
        headers: table.headers,
        rows: table.rows,
      });

      return textResult(
        "Opened the editable table widget. Wait for the user to submit the final Markdown table back into chat before continuing.",
        {
          ok: true,
          title,
          columns: table.headers.length,
          rows: table.rows.length,
        },
      );
    },
  });
}
