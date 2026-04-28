/**
 * output.ts — Output collection and JSON envelope helpers for git-query-tools.
 */

import type { CollectResult, ToolEnvelope, ToolMeta } from "./types.js";
import { encoder, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "./constants.js";

export function stripTrailing(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === "\n" || s[end - 1] === "\r")) end--;
  return end === s.length ? s : s.slice(0, end);
}

export function collectOutput(
  stdout: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
): CollectResult {
  const cleaned = stripTrailing(stdout);
  if (!cleaned) return { output: "", totalLines: 0, totalBytes: 0, truncated: false };
  const allLines = cleaned.split("\n");
  const totalLines = allLines.length;
  const totalBytes = encoder.encode(cleaned).length;
  let output = cleaned;
  let truncated = false;
  if (allLines.length > maxLines) {
    output = allLines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (encoder.encode(output).length > maxBytes) {
    const lines = output.split("\n");
    let safe = "";
    let safeBytes = 0;
    for (const line of lines) {
      const lineBytes = encoder.encode(line).length;
      const sep = safe ? 1 : 0; // newline separator byte
      if (safeBytes + sep + lineBytes > maxBytes) break;
      safe = safe ? safe + "\n" + line : line;
      safeBytes += sep + lineBytes;
    }
    output = safe;
    truncated = true;
  }
  return { output, totalLines, totalBytes, truncated };
}

export function envelope(e: ToolEnvelope): string {
  const o: ToolEnvelope = { tool: e.tool, status: e.status, summary: e.summary };
  if (e.content !== undefined) o.content = e.content;
  if (e.warnings?.length) o.warnings = e.warnings;
  if (e.meta && Object.keys(e.meta).length > 0) o.meta = e.meta;
  return JSON.stringify(o, null, 2);
}

export function ok(
  tool: string,
  summary: string,
  opts: { content?: string; warnings?: string[]; meta?: ToolMeta } = {},
): string {
  return envelope({ tool, status: "ok", summary, ...opts });
}

export function err(
  tool: string,
  summary: string,
  opts: { content?: string; warnings?: string[]; meta?: ToolMeta } = {},
): string {
  return envelope({ tool, status: "error", summary, ...opts });
}
