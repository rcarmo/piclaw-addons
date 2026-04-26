/**
 * compat/structured-tool-response.ts — Standalone version of piclaw's structured tool response formatter.
 */

import { buildPreview, saveToolOutput } from "./tool-output.js";

const STORE_THRESHOLD_BYTES = parseInt(process.env.PICLAW_TOOL_OUTPUT_STORE_BYTES || "4096", 10);
const STORE_THRESHOLD_LINES = parseInt(process.env.PICLAW_TOOL_OUTPUT_STORE_LINES || "40", 10);
const PREVIEW_LINES = parseInt(process.env.PICLAW_TOOL_OUTPUT_PREVIEW_LINES || "8", 10);
const PREVIEW_LINE_CHARS = parseInt(process.env.PICLAW_TOOL_OUTPUT_PREVIEW_LINE_CHARS || "200", 10);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderStructuredValue(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function countLines(text: string): number {
  return text ? text.replace(/\r\n/g, "\n").split("\n").length : 0;
}

function shouldStoreOutput(text: string): boolean {
  return Buffer.byteLength(text, "utf8") > STORE_THRESHOLD_BYTES || countLines(text) > STORE_THRESHOLD_LINES;
}

export interface StructuredToolResponsePresentation {
  text: string;
  stored_output?: {
    id: string;
    path: string;
    line_count: number;
    size_bytes: number;
    summary: string;
  };
}

export function presentStructuredToolValue(
  summary: string,
  label: string,
  value: unknown,
  source: string,
): StructuredToolResponsePresentation {
  const rendered = renderStructuredValue(value);
  if (!rendered) return { text: summary };

  if (!shouldStoreOutput(rendered)) {
    return { text: `${summary}\n${label}:\n${rendered}` };
  }

  const preview = buildPreview(rendered, PREVIEW_LINES, PREVIEW_LINE_CHARS);
  const saved = saveToolOutput(rendered, { source, summary: preview });

  const text = [
    summary,
    `${label} stored as tool-output:${saved.id} (${saved.lineCount} lines, ${formatBytes(saved.sizeBytes)}).`,
    preview ? `Preview:\n${preview}` : null,
    `Use search_tool_output with handle "${saved.id}" to search snippets, or read ${saved.path} for the full payload.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    text,
    stored_output: { id: saved.id, path: saved.path, line_count: saved.lineCount, size_bytes: saved.sizeBytes, summary: saved.summary },
  };
}
