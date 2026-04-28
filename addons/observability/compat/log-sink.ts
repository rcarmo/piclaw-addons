/**
 * compat/log-sink.ts — Log sink client for standalone addons.
 *
 * Resolves piclaw's runtime addLogSink/removeLogSink when available.
 * Falls back to no-op when running standalone.
 */

export interface LogRecord {
  ts: string;
  level: string;
  module: string;
  message: string;
  operation?: string;
  chatJid?: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

let runtimeAddLogSink: ((sink: LogSink) => void) | null = null;
let runtimeRemoveLogSink: ((sink: LogSink) => void) | null = null;

function resolveRuntime(): boolean {
  if (runtimeAddLogSink && runtimeRemoveLogSink) return true;

  try {
    const interop = (globalThis as {
      __piclawRuntimeInterop?: {
        addLogSink?: (sink: LogSink) => void;
        removeLogSink?: (sink: LogSink) => void;
      };
    }).__piclawRuntimeInterop;
    if (typeof interop?.addLogSink === "function" && typeof interop?.removeLogSink === "function") {
      runtimeAddLogSink = interop.addLogSink;
      runtimeRemoveLogSink = interop.removeLogSink;
      return true;
    }
  } catch {}

  try {
    const mod = require("piclaw/runtime/src/utils/logger.js");
    if (typeof mod?.addLogSink === "function" && typeof mod?.removeLogSink === "function") {
      runtimeAddLogSink = mod.addLogSink;
      runtimeRemoveLogSink = mod.removeLogSink;
      return true;
    }
  } catch {}
  return false;
}

export function addLogSink(sink: LogSink): boolean {
  if (!resolveRuntime()) return false;
  runtimeAddLogSink!(sink);
  return true;
}

export function removeLogSink(sink: LogSink): void {
  runtimeRemoveLogSink?.(sink);
}
