/**
 * compat.ts — Compatibility shims for standalone addon.
 * Replaces piclaw internal imports with self-contained alternatives.
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

const WORKSPACE_DIR = process.env.PICLAW_WORKSPACE || "/workspace";

type PiclawRuntimeAddonApi = {
  createMedia?: (
    filename: string,
    contentType: string,
    data: Uint8Array,
    thumbnail: Uint8Array | null,
    metadata: Record<string, unknown> | null,
  ) => number;
  postMessage?: (params: Record<string, unknown>, defaultChat?: string) => unknown;
};

type RuntimeGlobal = typeof globalThis & {
  __piclaw_runtime?: PiclawRuntimeAddonApi;
};

function getRuntimeApi(): PiclawRuntimeAddonApi | null {
  const runtimeGlobal = globalThis as RuntimeGlobal;
  return runtimeGlobal.__piclaw_runtime || null;
}

/**
 * Lightweight replacement for piclaw's createMedia.
 * Writes the file to a known export directory and returns a pseudo media ID.
 * The addon should use attach_file tool to deliver the report to the user.
 */
let nextMediaId = Date.now();

export function createMedia(
  filename: string,
  contentType: string,
  data: Buffer,
  _extra: unknown,
  meta?: Record<string, unknown>,
): number {
  const runtimeApi = getRuntimeApi();
  if (runtimeApi?.createMedia) {
    return runtimeApi.createMedia(filename, contentType, data, null, meta || null);
  }

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
export function postMessagesToolMessage(params: Record<string, unknown>, defaultChat = "web:default"): void {
  const runtimeApi = getRuntimeApi();
  runtimeApi?.postMessage?.(params, defaultChat);
}
