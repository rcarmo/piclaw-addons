/**
 * compat.ts — Compatibility shims for standalone addon.
 * Replaces piclaw internal imports with self-contained alternatives.
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

const WORKSPACE_DIR = process.env.PICLAW_WORKSPACE || "/workspace";

/**
 * Lightweight replacement for piclaw's createMedia.
 * Writes the file to a known export directory and returns a pseudo media ID.
 * The addon should use attach_file tool to deliver the report to the user.
 */
let nextMediaId = Date.now();

export function createMedia(
  filename: string,
  _contentType: string,
  data: Buffer,
  _extra: unknown,
  _meta?: Record<string, unknown>,
): number {
  const exportDir = join(WORKSPACE_DIR, ".piclaw", "tmp");
  if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });
  const outPath = join(exportDir, `${nextMediaId}-${basename(filename)}`);
  writeFileSync(outPath, data);
  return nextMediaId++;
}

/**
 * Post a message via the messages tool. In addon context, this is a no-op
 * since the extension API doesn't have direct message posting. The supervisor
 * returns results through tool call responses instead.
 */
export function postMessagesToolMessage(params: Record<string, unknown>): void {
  // In addon mode, message posting is handled through tool responses.
  // This is a compatibility stub.
}
