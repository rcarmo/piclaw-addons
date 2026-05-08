/**
 * dev-tools.ts — git_history + json_query tools for Piclaw.
 *
 * Ported from cjnova/oc-tool-in-a-box OpenCode tools.
 * Drop into .pi/extensions/ and /reload.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolve, relative, isAbsolute, extname } from "node:path";

/* ── Output collection helpers (from _collect-output.ts) ──────────── */

const encoder = new TextEncoder();
const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_BYTES = 51200;
const DEFAULT_TIMEOUT = 30_000;
const FAST_TIMEOUT = 10_000;
const MAX_PROCESS_OUTPUT = 10 * 1024 * 1024;
const BASE_DIR = "/workspace";

interface CollectResult {
  output: string;
  totalLines: number;
  totalBytes: number;
  truncated: boolean;
}

type ToolMeta = Record<string, string | number | boolean | null>;

interface ToolEnvelope {
  tool: string;
  status: "ok" | "error";
  summary: string;
  content?: string;
  warnings?: string[];
  meta?: ToolMeta;
}

function stripTrailing(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === "\n" || s[end - 1] === "\r")) end--;
  return end === s.length ? s : s.slice(0, end);
}

function collectOutput(stdout: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES): CollectResult {
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
    for (const line of lines) {
      const candidate = safe ? safe + "\n" + line : line;
      if (encoder.encode(candidate).length > maxBytes) break;
      safe = candidate;
    }
    output = safe;
    truncated = true;
  }
  return { output, totalLines, totalBytes, truncated };
}

function envelope(e: ToolEnvelope): string {
  const o: ToolEnvelope = { tool: e.tool, status: e.status, summary: e.summary };
  if (e.content !== undefined) o.content = e.content;
  if (e.warnings?.length) o.warnings = e.warnings;
  if (e.meta && Object.keys(e.meta).length > 0) o.meta = e.meta;
  return JSON.stringify(o, null, 2);
}

function ok(tool: string, summary: string, opts: { content?: string; warnings?: string[]; meta?: ToolMeta } = {}): string {
  return envelope({ tool, status: "ok", summary, ...opts });
}

function err(tool: string, summary: string, opts: { content?: string; warnings?: string[]; meta?: ToolMeta } = {}): string {
  return envelope({ tool, status: "error", summary, ...opts });
}

/* ── Process runner ─────────────────────────────────────────────── */

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signalCode: string | null;
}

async function readCapped(
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
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return { text: new TextDecoder().decode(merged), capped };
}

async function runProcess(
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
    return { stdout: "", stderr: `Failed to spawn '${cmd[0]}': ${msg}`, exitCode: 127, signalCode: null };
  }

  // Wire AbortSignal to kill subprocess
  if (opts.signal) {
    const abort = () => { try { proc.kill("SIGKILL"); } catch {} };
    if (opts.signal.aborted) { abort(); }
    else { opts.signal.addEventListener("abort", abort, { once: true }); }
  }

  const killOnCap = () => { try { proc.kill("SIGKILL"); } catch {} };
  const [stdoutR, stderrR] = await Promise.all([
    readCapped(proc.stdout as ReadableStream<Uint8Array>, MAX_PROCESS_OUTPUT, killOnCap),
    readCapped(proc.stderr as ReadableStream<Uint8Array>, MAX_PROCESS_OUTPUT, killOnCap),
  ]);
  await proc.exited;

  let stderr = stderrR.text;
  if (stdoutR.capped) stderr = `[stdout capped at ${MAX_PROCESS_OUTPUT / 1024 / 1024}MB] ${stderr}`;
  if (stderrR.capped) stderr = `[stderr capped at ${MAX_PROCESS_OUTPUT / 1024 / 1024}MB] ${stderr}`;

  return { stdout: stdoutR.text, stderr, exitCode: proc.exitCode, signalCode: proc.signalCode as string | null };
}

/* ── Security helpers ──────────────────────────────────────────── */

function safePath(file: string | undefined): { resolved: string; error?: string } {
  if (!file) return { resolved: BASE_DIR };
  const resolved = resolve(BASE_DIR, file);
  if (!resolved.startsWith(BASE_DIR + "/") && resolved !== BASE_DIR) {
    return { resolved: "", error: "path outside workspace" };
  }
  return { resolved };
}

function relPath(file: string): string {
  const r = resolve(BASE_DIR, file);
  return relative(BASE_DIR, r);
}

const JQ_DENYLIST = /(?:^|\b)(env|debug|input|inputs|halt|stderr|builtins)(?:\b|$)|\$ENV|\bpath\s*\(|\bgetpath\b/;

function checkJqExpression(expr: string): string | null {
  // Allow .env (key access) but block bare env, $ENV, etc.
  const stripped = expr.replace(/\.\w+/g, ""); // remove .key accesses
  if (JQ_DENYLIST.test(stripped)) return "blocked jq builtin";
  return null;
}

/* ── Validation helpers ────────────────────────────────────────── */

function validateText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  if (!t) return `'${field}' cannot be empty`;
  if (/\r|\n/.test(t)) return `'${field}' must be a single-line value`;
  if (!/[A-Za-z0-9]/.test(t)) return `'${field}' must contain at least one letter or number`;
  return undefined;
}

function parseBlameLines(lines?: string): { normalized?: string; error?: string } {
  if (!lines) return {};
  const t = lines.trim();
  if (!t) return { error: "'lines' cannot be empty for blame mode" };
  const single = t.match(/^(\d+)$/);
  if (single) {
    const n = Number(single[1]);
    if (n < 1) return { error: "'lines' must be positive integers" };
    return { normalized: `${n},${n}` };
  }
  const range = t.match(/^(\d+)(,|:|\.\.|-)(\d+)$/);
  if (!range) return { error: "'lines' must be a single line like '10' or a range like '10,20', '10:20', '10..20', or '10-20'" };
  const start = Number(range[1]), end = Number(range[3]);
  if (start < 1 || end < 1) return { error: "'lines' must use positive integers" };
  if (start > end) return { error: "'lines' start must be <= end" };
  return { normalized: `${start},${end}` };
}

/* ── Tool result helper ────────────────────────────────────────── */

function result(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/* ── Extension entry point ─────────────────────────────────────── */

export default function (pi: ExtensionAPI) {
  // Pre-flight: verify binaries exist
  try {
    Bun.spawnSync(["which", "git"]);
    Bun.spawnSync(["which", "jq"]);
  } catch (e) {
    console.warn("[dev-tools] git or jq not found:", e);
  }

  /* ── git_history ─────────────────────────────────────────────── */

  const TOOL_GIT = "git-history";

  async function runGit(args: string[], mode: string, signal?: AbortSignal) {
    const { stdout, stderr, exitCode, signalCode } = await runProcess(
      ["git", ...args], { cwd: BASE_DIR, timeout: DEFAULT_TIMEOUT, signal },
    );
    if (signalCode) {
      return err(TOOL_GIT, "History query was killed", {
        meta: { mode, signal: signalCode, timedOut: signalCode === "SIGKILL", timeoutMs: DEFAULT_TIMEOUT },
      });
    }
    if (exitCode !== 0) {
      return err(TOOL_GIT, stripTrailing(stderr) || stripTrailing(stdout) || `git exited with code ${exitCode}`, {
        meta: { mode, exitCode: exitCode ?? -1 },
      });
    }
    const raw = stripTrailing(stdout);
    if (!raw) {
      return ok(TOOL_GIT, "No results found", { meta: { mode, resultCount: 0, truncated: false } });
    }
    const { output, totalLines, totalBytes, truncated } = collectOutput(raw);
    return ok(TOOL_GIT, truncated ? "Results truncated" : "Results returned", {
      content: output,
      meta: { mode, totalLines, totalBytes, truncated },
    });
  }

  pi.registerTool({
    name: "git_history",
    label: "Git History",
    description: "Inspect git history: commits, code-history searches, commit-message searches, and blame. Prefer over raw git commands for structured history queries with truncation. Returns JSON envelope.",
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("log"), Type.Literal("content_search"), Type.Literal("message_search"), Type.Literal("blame")], {
        description: "log=recent commits, content_search=string-in-diff, message_search=commit message search, blame=file blame",
      }),
      query: Type.Optional(Type.String({ description: "Required for content_search and message_search" })),
      file: Type.Optional(Type.String({ description: "File path (relative or absolute). Required for blame." })),
      max_count: Type.Optional(Type.Number({ description: "Max commits (default 20)" })),
      author: Type.Optional(Type.String({ description: "Author name/email pattern" })),
      since: Type.Optional(Type.String({ description: "Git date filter, e.g. '2024-01-01'" })),
      diff: Type.Optional(Type.Boolean({ description: "Include patch output (not in blame)" })),
      lines: Type.Optional(Type.String({ description: "Line range for blame: '10', '10,20', '10:20'" })),
      all: Type.Optional(Type.Boolean({ description: "Search all branches (cannot combine with ref)" })),
      ref: Type.Optional(Type.String({ description: "Branch/tag/ref to search" })),
    }),
    async execute(_id, params, signal) {
      type P = typeof params;
      const p = params as P;

      // Validation
      const checks = [
        validateText(p.query, "query"),
        validateText(p.file, "file"),
        validateText(p.author, "author"),
        validateText(p.since, "since"),
        validateText(p.ref, "ref"),
      ];
      for (const e of checks) if (e) return result(err(TOOL_GIT, e));

      if (p.max_count !== undefined && (!Number.isInteger(p.max_count) || p.max_count < 1))
        return result(err(TOOL_GIT, "'max_count' must be a positive integer"));
      if (p.all && p.ref) return result(err(TOOL_GIT, "choose either 'all' or 'ref', not both"));
      if (p.mode === "blame" && p.diff) return result(err(TOOL_GIT, "'diff' not supported in blame"));
      if (p.mode !== "blame" && p.lines) return result(err(TOOL_GIT, "'lines' only for blame mode"));

      // Path security
      if (p.file) {
        const { error } = safePath(p.file);
        if (error) return result(err(TOOL_GIT, error));
      }

      const maxCount = p.max_count ?? 20;
      const common = [`--max-count=${maxCount}`, "--format=%h %ad %an | %s", "--date=short"];
      if (p.author) common.push(`--author=${p.author.trim()}`);
      if (p.since) common.push(`--since=${p.since.trim()}`);

      switch (p.mode) {
        case "log": {
          const args = ["log", ...common, ...(p.all ? ["--all"] : p.ref ? [p.ref.trim()] : [])];
          if (p.diff) args.push("-p");
          if (p.file) args.push("--follow", "--", relPath(p.file.trim()));
          return result(await runGit(args, "log", signal));
        }
        case "content_search": {
          if (!p.query) return result(err(TOOL_GIT, "'query' required for content_search"));
          const args = ["log", `-S${p.query.trim()}`, ...common, ...(p.all ? ["--all"] : p.ref ? [p.ref.trim()] : [])];
          if (p.diff) args.push("-p");
          if (p.file) args.push("--follow", "--", relPath(p.file.trim()));
          return result(await runGit(args, "content_search", signal));
        }
        case "message_search": {
          if (!p.query) return result(err(TOOL_GIT, "'query' required for message_search"));
          const args = ["log", `--grep=${p.query.trim()}`, ...common, ...(p.all ? ["--all"] : p.ref ? [p.ref.trim()] : [])];
          if (p.diff) args.push("-p");
          if (p.file) args.push("--follow", "--", relPath(p.file.trim()));
          return result(await runGit(args, "message_search", signal));
        }
        case "blame": {
          if (!p.file) return result(err(TOOL_GIT, "'file' required for blame"));
          const resolved = relPath(p.file.trim());
          const args = ["blame", "--date=short"];
          const { normalized, error: lineErr } = parseBlameLines(p.lines);
          if (lineErr) return result(err(TOOL_GIT, lineErr));
          if (normalized) args.push(`-L${normalized}`);
          if (p.ref) args.push(p.ref.trim());
          args.push("--", resolved);
          return result(await runGit(args, "blame", signal));
        }
      }
      return result(err(TOOL_GIT, `Unknown mode: ${p.mode}`));
    },
  });

  /* ── json_query ──────────────────────────────────────────────── */

  const TOOL_JQ = "json-query";

  pi.registerTool({
    name: "json_query",
    label: "JSON Query",
    description: "Extract, filter, and reshape JSON data with jq expressions. Prefer over shell-based filtering for clearer validation. Returns JSON envelope.",
    parameters: Type.Object({
      expression: Type.Optional(Type.String({ description: "jq expression (required unless keys_only)" })),
      file: Type.Optional(Type.String({ description: "Path to JSON file (mutually exclusive with input)" })),
      input: Type.Optional(Type.String({ description: "Inline JSON string (mutually exclusive with file)" })),
      raw_output: Type.Optional(Type.Boolean({ description: "Output raw strings without JSON quotes" })),
      slurp: Type.Optional(Type.Boolean({ description: "Read entire input into array" })),
      compact: Type.Optional(Type.Boolean({ description: "Compact output" })),
      keys_only: Type.Optional(Type.Boolean({ description: "List root-level keys (overrides expression)" })),
    }),
    async execute(_id, params, signal) {
      type P = typeof params;
      const p = params as P;

      // Validation
      const exprErr = p.expression !== undefined && !p.expression.trim() ? "'expression' cannot be empty" : undefined;
      if (exprErr) return result(err(TOOL_JQ, exprErr));
      const fileErr = validateText(p.file, "file");
      if (fileErr) return result(err(TOOL_JQ, fileErr));
      const inputErr = p.input !== undefined && !p.input.trim() ? "'input' cannot be empty" : undefined;
      if (inputErr) return result(err(TOOL_JQ, inputErr));

      const hasFile = typeof p.file === "string";
      const hasInput = typeof p.input === "string";
      if (hasFile === hasInput) return result(err(TOOL_JQ, "exactly one of file or input must be provided"));

      // Path security
      let resolvedPath: string | undefined;
      if (hasFile) {
        const { resolved, error } = safePath(p.file!);
        if (error) return result(err(TOOL_JQ, error));
        resolvedPath = resolved;
      }

      const expressionOverridden = p.keys_only && p.expression;
      const expression = p.keys_only ? "keys" : p.expression?.trim();
      if (!expression) return result(err(TOOL_JQ, "expression is required (unless keys_only is true)"));

      // jq expression denylist
      const blocked = checkJqExpression(expression);
      if (blocked) return result(err(TOOL_JQ, blocked));

      const flags: string[] = [];
      if (p.raw_output) flags.push("-r");
      if (p.slurp) flags.push("-s");
      if (p.compact) flags.push("-c");
      flags.push("-e");

      const cmd = resolvedPath
        ? ["jq", ...flags, "--", expression, resolvedPath]
        : ["jq", ...flags, "--", expression];
      const stdinBlob = resolvedPath ? undefined : new Blob([p.input!.trim()]);

      const { stdout, stderr, exitCode, signalCode } = await runProcess(cmd, {
        stdin: stdinBlob,
        timeout: FAST_TIMEOUT,
        signal,
      });

      const warnings = expressionOverridden ? [`keys_only=true ignored expression '${p.expression?.trim()}'`] : undefined;

      if (signalCode) {
        return result(err(TOOL_JQ, "Query killed", {
          meta: { signal: signalCode, timedOut: signalCode === "SIGKILL", timeoutMs: FAST_TIMEOUT },
        }));
      }

      // jq exit codes: 0=ok, 1=false/null, 4=empty, other=error
      if ((exitCode === 1 || exitCode === 4) && !stderr.trim()) {
        const raw = stripTrailing(stdout);
        if (raw) {
          const { output, totalLines, totalBytes, truncated } = collectOutput(raw);
          const label = exitCode === 1 ? "false/null result" : "empty result";
          return result(ok(TOOL_JQ, `Query completed with ${label}`, {
            content: output, warnings,
            meta: { totalLines, totalBytes, truncated, expressionOverridden: Boolean(expressionOverridden) },
          }));
        }
        return result(ok(TOOL_JQ, exitCode === 1 ? "Result was false or null" : "Empty result set", {
          warnings, meta: { expressionOverridden: Boolean(expressionOverridden), truncated: false },
        }));
      }

      if (exitCode !== 0) {
        const msg = stderr.trim() || `exit code ${exitCode}`;
        if (resolvedPath && (msg.includes("parse error") || msg.includes("Invalid"))) {
          const ext = extname(resolvedPath).toLowerCase();
          const hint = ext === ".json"
            ? "File may contain invalid JSON."
            : `File extension is '${ext}' — ensure it contains valid JSON.`;
          return result(err(TOOL_JQ, `${msg} ${hint}`, { meta: { exitCode: exitCode ?? -1 } }));
        }
        return result(err(TOOL_JQ, msg, { meta: { exitCode: exitCode ?? -1 } }));
      }

      const trimmed = stripTrailing(stdout);
      if (!trimmed) {
        return result(ok(TOOL_JQ, "Empty result", {
          warnings, meta: { expressionOverridden: Boolean(expressionOverridden), truncated: false },
        }));
      }

      const { output, totalLines, totalBytes, truncated } = collectOutput(trimmed);
      return result(ok(TOOL_JQ, truncated ? "Query completed; truncated" : `Query completed (${totalLines} lines)`, {
        content: output, warnings,
        meta: { totalLines, totalBytes, truncated, expressionOverridden: Boolean(expressionOverridden) },
      }));
    },
  });
}
