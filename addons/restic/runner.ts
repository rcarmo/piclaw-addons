import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { setPriority } from "node:os";
import { join } from "node:path";
import type { RunOptions, RunResult } from "./contracts.ts";
import { repositoryPlan } from "./repository.ts";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 1_000;
const FORCE_SETTLE_MS = 5_000;

function dedupeSecrets(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort((a, b) => b.length - a.length);
}

function redactText(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of dedupeSecrets(secrets)) result = result.split(secret).join("[REDACTED]");
  return result;
}

function redactError(error: unknown, secrets: readonly string[]): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  const redacted = new Error(redactText(source.message || String(source), secrets));
  redacted.name = source.name || "Error";
  return redacted;
}

function sanitizeSpawnError(binary: string, error: unknown, secrets: readonly string[]): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  const code = typeof source === "object" && source && "code" in source ? (source as { code?: unknown }).code : undefined;
  let detail = source.message || String(source);
  if (code === "ENOENT") detail = "not found";
  else if (code === "EACCES") detail = "permission denied";
  const failure = new Error(`Failed to start Restic binary ${JSON.stringify(binary)}: ${detail}`);
  failure.name = source.name || "Error";
  return redactError(failure, secrets);
}

function shellQuote(value: string): string {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Unsafe generated Restic transport path");
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sendSignal(pid: number | undefined, child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

export async function prepareTransport(
  config: unknown,
  privateDir: string,
  resolveSecret: (ref: string) => Promise<string>,
): Promise<{ args: string[]; env: Record<string, string>; secrets: string[]; cleanup(): void }> {
  const plan = repositoryPlan(config);
  const env: Record<string, string> = {};
  if (typeof process.env.PATH === "string") env.PATH = process.env.PATH;
  for (const [key, value] of Object.entries(plan.environment)) env[key] = value;

  const secrets: string[] = [];
  for (const [key, ref] of Object.entries(plan.credentialRefs)) {
    const value = await resolveSecret(ref);
    env[key] = value;
    secrets.push(value);
  }

  const args = ["--repo", plan.repository];
  let materializedDir: string | undefined;
  const cleanup = () => {
    if (!materializedDir) return;
    rmSync(materializedDir, { recursive: true, force: true });
    materializedDir = undefined;
  };

  try {
    if (plan.ssh) {
      mkdirSync(privateDir, { recursive: true, mode: 0o700 });
      chmodSync(privateDir, 0o700);
      materializedDir = mkdtempSync(join(privateDir, "sftp-"));
      chmodSync(materializedDir, 0o700);

      const [privateKey, knownHosts] = await Promise.all([
        resolveSecret(plan.ssh.privateKeyRef),
        resolveSecret(plan.ssh.knownHostsRef),
      ]);
      secrets.push(privateKey, knownHosts);

      const keyPath = join(materializedDir, "id");
      const knownHostsPath = join(materializedDir, "known_hosts");
      writeFileSync(keyPath, privateKey, { mode: 0o600, flag: "wx" });
      writeFileSync(knownHostsPath, knownHosts, { mode: 0o600, flag: "wx" });
      chmodSync(keyPath, 0o600);
      chmodSync(knownHostsPath, 0o600);

      const command = [
        "ssh",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        shellQuote(`UserKnownHostsFile=${knownHostsPath}`),
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-F",
        "/dev/null",
        "-i",
        shellQuote(keyPath),
        "-p", String(plan.ssh.port), "-s", shellQuote(`${plan.ssh.user}@${plan.ssh.host}`), "sftp",
      ].join(" ");
      args.push("-o", `sftp.command=${command}`);
    }
    return { args, env, secrets: dedupeSecrets(secrets), cleanup };
  } catch (error) {
    cleanup();
    throw new Error("Restic credentials could not be prepared; verify the selected keychain references and private directory");
  }
}

export async function runRestic(options: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const maxOutputBytes = Number.isFinite(options.maxOutputBytes) && (options.maxOutputBytes as number) > 0
    ? Math.floor(options.maxOutputBytes as number)
    : DEFAULT_MAX_OUTPUT_BYTES;
  const secrets = dedupeSecrets(options.redact ?? []);

  if (options.signal?.aborted) {
    const error = new Error("Aborted");
    error.name = "AbortError";
    throw redactError(error, secrets);
  }

  return await new Promise<RunResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.binary, options.args, {
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(sanitizeSpawnError(options.binary, error, secrets));
      return;
    }

    if (process.platform !== "win32" && child.pid) {
      try { setPriority(child.pid, 10); } catch {}
    }

    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminating: Error | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finishError = (error: Error) => redactError(error, secrets);

    const terminate = (error: Error) => {
      if (settled || terminating) return;
      terminating = error;
      sendSignal(child.pid, child, "SIGTERM");
      killTimer = setTimeout(() => sendSignal(child.pid, child, "SIGKILL"), KILL_GRACE_MS);
      forceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(finishError(error));
      }, FORCE_SETTLE_MS);
    };

    const onAbort = () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      terminate(error);
    };

    if (options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => terminate(new Error(`Restic timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
    }
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const handleData = (
      stream: "stdout" | "stderr",
      decoder: TextDecoder,
      append: (text: string) => void,
      chunk: Buffer,
    ) => {
      if (settled || terminating) return;
      const nextBytes = stream === "stdout" ? (stdoutBytes += chunk.length) : (stderrBytes += chunk.length);
      if (nextBytes > maxOutputBytes) {
        terminate(new Error(`Restic ${stream} exceeded ${maxOutputBytes} bytes`));
        return;
      }
      append(decoder.decode(chunk, { stream: true }));
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      handleData("stdout", stdoutDecoder, (text) => { stdout += text; }, buffer);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      handleData("stderr", stderrDecoder, (text) => { stderr += text; }, buffer);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(sanitizeSpawnError(options.binary, error, secrets));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout += stdoutDecoder.decode();
      stderr += stderrDecoder.decode();
      if (terminating) {
        sendSignal(child.pid, child, "SIGKILL");
        reject(finishError(terminating));
        return;
      }
      resolve({
        code: code ?? 128,
        stdout: redactText(stdout, secrets),
        stderr: redactText(stderr, secrets),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
