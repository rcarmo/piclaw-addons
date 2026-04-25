/**
 * compat/tool-output.ts — Tool output store shim for standalone addons.
 * Writes large tool responses to workspace files for search_tool_output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const WORKSPACE_DIR = process.env.PICLAW_WORKSPACE || "/workspace";
const OUTPUT_DIR = join(WORKSPACE_DIR, ".piclaw", "data", "tool-output");

let outputCounter = 0;

function generateId(): string {
  const hex = () => Math.random().toString(16).slice(2, 10);
  return `out-${hex()}-${hex()}-${hex()}-${hex()}-${hex()}`;
}

export interface SavedToolOutput {
  id: string;
  path: string;
  lineCount: number;
  sizeBytes: number;
  summary: string;
}

export function saveToolOutput(
  content: string,
  options?: { source?: string; summary?: string },
): SavedToolOutput {
  const id = generateId();
  const filename = `${id}.log`;
  const outputPath = join(OUTPUT_DIR, filename);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, "utf8");

  const sizeBytes = Buffer.byteLength(content, "utf8");
  const lineCount = content ? content.split("\n").length : 0;
  const summary = options?.summary || buildPreview(content, 8, 200);

  return { id, path: outputPath, lineCount, sizeBytes, summary };
}

export function buildPreview(text: string, maxLines = 8, maxLineChars = 200): string {
  if (!text) return "";
  const lines = text.split("\n").slice(0, maxLines);
  return lines
    .map((line) => (line.length > maxLineChars ? line.slice(0, maxLineChars) + "…" : line))
    .join("\n");
}
