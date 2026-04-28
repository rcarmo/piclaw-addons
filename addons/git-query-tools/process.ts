/**
 * process.ts — Subprocess runner with output capping for git-query-tools.
 */

import type { SpawnResult } from "./types.js";
import { MAX_PROCESS_OUTPUT } from "./constants.js";

export async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onCap?: () => void,
): Promise<{ text: string; capped: boolean }> {
  if (!stream) return { text: "", capped: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      total += value.length;
      if (total > maxBytes) {
        const excess = total - maxBytes;
        chunks.push(value.slice(0, value.length - excess));
        capped = true;
        onCap?.();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(merged), capped };
}

export async function runProcess(
  cmd: string[],
  opts: { cwd?: string; stdin?: Blob; timeout: number; signal?: AbortSignal },
): Promise<SpawnResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeout,
      killSignal: "SIGKILL",
      cwd: opts.cwd,
      stdin: opts.stdin,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      stdout: "",
      stderr: `Failed to spawn '${cmd[0]}': ${msg}`,
      exitCode: 127,
      signalCode: null,
    };
  }

  if (opts.signal) {
    const abort = () => {
      try { proc.kill("SIGKILL"); } catch {}
    };
    if (opts.signal.aborted) { abort(); }
    else { opts.signal.addEventListener("abort", abort, { once: true }); }
    // Remove the listener after the process exits normally to prevent a leak
    proc.exited.then(() => opts.signal!.removeEventListener("abort", abort)).catch(() => {});
  }

  const killOnCap = () => {
    try { proc.kill("SIGKILL"); } catch {}
  };
  const [stdoutR, stderrR] = await Promise.all([
    readCapped(proc.stdout as ReadableStream<Uint8Array>, MAX_PROCESS_OUTPUT, killOnCap),
    readCapped(proc.stderr as ReadableStream<Uint8Array>, MAX_PROCESS_OUTPUT, killOnCap),
  ]);
  await proc.exited;

  let stderr = stderrR.text;
  if (stdoutR.capped) stderr = `[stdout capped at ${MAX_PROCESS_OUTPUT / 1024 / 1024}MB] ${stderr}`;
  if (stderrR.capped) stderr = `[stderr capped at ${MAX_PROCESS_OUTPUT / 1024 / 1024}MB] ${stderr}`;

  return {
    stdout: stdoutR.text,
    stderr,
    exitCode: proc.exitCode,
    signalCode: proc.signalCode as string | null,
  };
}
