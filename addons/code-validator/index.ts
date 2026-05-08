/**
 * code-validator.ts — diagnostics tool for code validation.
 *
 * Registers a `diagnostics` tool the agent calls explicitly to validate files.
 * Built-in validators for Python, JS/TS, JSON. Extensible via .pi/validators.json.
 *
 * Drop into .pi/extensions/ and /reload.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolve, extname } from "node:path";
import { readFileSync, existsSync } from "node:fs";

/* ── Types ────────────────────────────────────────────────────────── */

interface ValidatorEntry {
  cmd: string[];
  env?: Record<string, string>;
}

/* ── Built-in validators ──────────────────────────────────────────── */

const oxlint: ValidatorEntry = { cmd: ["bunx", "oxlint", "$FILE"] };
const pycompile: ValidatorEntry = { cmd: ["python3", "-m", "py_compile", "$FILE"] };
const jqcheck: ValidatorEntry = { cmd: ["jq", ".", "$FILE"] };

const BUILT_IN: Record<string, ValidatorEntry[]> = {};
[".ts", ".tsx", ".js", ".jsx"].forEach((ext) => (BUILT_IN[ext] = [oxlint]));
BUILT_IN[".py"] = [pycompile];
BUILT_IN[".json"] = [jqcheck];

/* ── Process runner ───────────────────────────────────────────────── */

const MAX_OUTPUT = 10 * 1024 * 1024;
const TIMEOUT = 30_000;
const BASE_DIR = "/workspace";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signalCode: string | null;
}

async function runValidator(
  cmd: string[],
  env?: Record<string, string>,
  signal?: AbortSignal,
): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: TIMEOUT,
      killSignal: "SIGKILL",
      cwd: BASE_DIR,
      env: env ? { ...process.env, ...env } : undefined,
    });
  } catch {
    return { stdout: "", stderr: `Command not found: ${cmd[0]}`, exitCode: 127, signalCode: null };
  }

  if (signal) {
    const abort = () => { try { proc.kill("SIGKILL"); } catch {} };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }

  const decoder = new TextDecoder();
  const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
    if (!stream) return "";
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        total += value.length;
        if (total > MAX_OUTPUT) { try { proc.kill("SIGKILL"); } catch {} break; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.length; }
    return decoder.decode(merged);
  };

  const [stdout, stderr] = await Promise.all([
    readStream(proc.stdout as ReadableStream<Uint8Array>),
    readStream(proc.stderr as ReadableStream<Uint8Array>),
  ]);
  await proc.exited;

  return { stdout, stderr, exitCode: proc.exitCode, signalCode: proc.signalCode as string | null };
}

/* ── Config loading ───────────────────────────────────────────────── */

function loadConfig(): Record<string, ValidatorEntry[]> | null {
  const configPath = resolve(BASE_DIR, ".pi/validators.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const result: Record<string, ValidatorEntry[]> = {};
    for (const [ext, val] of Object.entries(raw)) {
      if (Array.isArray(val)) {
        result[ext] = (val as Array<{ command: string[]; env?: Record<string, string> }>).map(
          (v) => ({ cmd: v.command, env: v.env }),
        );
      } else if (val && typeof val === "object") {
        const v = val as { command: string[]; env?: Record<string, string> };
        result[ext] = [{ cmd: v.command, env: v.env }];
      }
    }
    return result;
  } catch {
    return null;
  }
}

function getRegistry(): Record<string, ValidatorEntry[]> {
  const registry = { ...BUILT_IN };
  const custom = loadConfig();
  if (custom) Object.assign(registry, custom);
  return registry;
}

/* ── Path security ────────────────────────────────────────────────── */

function safePath(file: string): { resolved: string; error?: string } {
  const resolved = resolve(BASE_DIR, file);
  if (!resolved.startsWith(BASE_DIR + "/") && resolved !== BASE_DIR) {
    return { resolved: "", error: "path outside workspace" };
  }
  return { resolved };
}

/* ── Extension entry point ────────────────────────────────────────── */

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "diagnostics",
    label: "Diagnostics",
    description:
      "Validate a code file for errors, lint issues, and style problems. " +
      "Call after writing code to check for issues. Extensible via .pi/validators.json.",
    parameters: Type.Object({
      file: Type.Optional(
        Type.String({ description: "File to validate (relative to workspace). Omit to list available validators." }),
      ),
    }),
    async execute(_id, params, signal) {
      const registry = getRegistry();

      // No file → list available validators
      if (!params.file) {
        const lines: string[] = ["Available validators:"];
        for (const [ext, validators] of Object.entries(registry)) {
          const cmds = validators.map((v) => v.cmd[0]).join(", ");
          lines.push(`  ${ext} → ${cmds}`);
        }
        const customLoaded = loadConfig() !== null;
        if (customLoaded) lines.push("\n(includes custom validators from .pi/validators.json)");
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { validators: Object.keys(registry) },
        };
      }

      // Validate file path
      const { resolved, error } = safePath(params.file);
      if (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], details: { error } };
      }

      if (!existsSync(resolved)) {
        return { content: [{ type: "text" as const, text: `File not found: ${params.file}` }], details: { error: "not found" } };
      }

      // Find validators for this extension
      const ext = extname(resolved).toLowerCase();
      const validators = registry[ext];
      if (!validators || validators.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No validator for ${ext}` }],
          details: { extension: ext, available: Object.keys(registry) },
        };
      }

      // Run all validators, collect results
      const results: string[] = [];
      let hasErrors = false;

      for (const validator of validators) {
        const cmd = validator.cmd.map((a) => (a === "$FILE" ? resolved : a));
        const toolName = cmd[0] === "bunx" || cmd[0] === "uvx" ? cmd[1] : cmd[0];

        const result = await runValidator(cmd, validator.env, signal);

        if (result.exitCode === 127) {
          results.push(`⚠ ${toolName}: not installed, skipping`);
          continue;
        }

        const output = (result.stderr || result.stdout).trim();
        if (result.exitCode !== 0 && output) {
          hasErrors = true;
          // Truncate to 10 diagnostics
          const lines = output.split("\n");
          const truncated = lines.length > 30;
          const shown = truncated ? lines.slice(0, 30).join("\n") + `\n... and ${lines.length - 30} more lines` : output;
          results.push(`❌ ${toolName}:\n${shown}`);
        } else if (result.exitCode === 0) {
          const warn = (result.stderr || result.stdout).trim();
          if (warn && (warn.includes("warning") || warn.includes("Warning"))) {
            results.push(`⚠ ${toolName} (warnings):\n${warn}`);
          } else {
            results.push(`✅ ${toolName}: no issues`);
          }
        } else if (result.signalCode) {
          results.push(`⚠ ${toolName}: killed (${result.signalCode})`);
        }
      }

      const summary = hasErrors ? "Issues found" : "No issues";
      return {
        content: [{ type: "text" as const, text: `${summary} in ${params.file}:\n\n${results.join("\n\n")}` }],
        details: { file: params.file, extension: ext, hasErrors, validatorCount: validators.length },
      };
    },
  });
}
