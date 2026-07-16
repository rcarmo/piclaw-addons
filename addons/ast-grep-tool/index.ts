/**
 * ast-grep-tool — Structural code search and rewrite via ast-grep.
 *
 * Registers two tools:
 *   code_search  — find code by AST pattern with metavariables
 *   code_rewrite — structural find-and-replace
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const WORKSPACE_ROOT = "/workspace";
const MAX_RESULTS = 100;
const MAX_OUTPUT_CHARS = 30_000;
const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type ToolUiContext = Pick<ExtensionContext, "hasUI" | "ui">;

export function startAstGrepProgress(ctx: ToolUiContext | undefined, message: string): void {
  if (!ctx?.hasUI) return;
  ctx.ui.setWorkingIndicator({ frames: WORKING_FRAMES, intervalMs: 90 });
  ctx.ui.setWorkingMessage(message);
}

export function finishAstGrepProgress(ctx: ToolUiContext | undefined): void {
  if (!ctx?.hasUI) return;
  ctx.ui.setWorkingMessage();
  ctx.ui.setWorkingIndicator();
}

export async function withAstGrepProgress<T>(ctx: ToolUiContext | undefined, message: string, fn: () => Promise<T>): Promise<T> {
  startAstGrepProgress(ctx, message);
  try {
    return await fn();
  } finally {
    finishAstGrepProgress(ctx);
  }
}

/** Resolve the ast-grep binary path.
 * Looks in local node_modules/.bin first (self-contained), then global PATH.
 * Never tries "sg" to avoid collision with /usr/bin/sg (util-linux). */
async function findAstGrepBinary(): Promise<string> {
  const localBin = new URL("./node_modules/.bin/ast-grep", import.meta.url).pathname;
  if (existsSync(localBin)) return localBin;

  try {
    const proc = Bun.spawn(["which", "ast-grep"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const path = text.trim();
    if (path) return path;
  } catch {
    // ignore and throw below
  }

  throw new Error(
    "ast-grep not found. Run 'bun install' in .pi/extensions/ast-grep-tool/ or install globally: npm i -g @ast-grep/cli",
  );
}

/** Run ast-grep command and capture output. */
function runAstGrep(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: WORKSPACE_ROOT,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_CHARS) {
        child.kill();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    signal?.addEventListener("abort", () => {
      if (!child.killed) child.kill();
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.on("error", reject);
  });
}

/** Supported languages for ast-grep tool descriptions. */
const SUPPORTED_LANGS = [
  "typescript", "javascript", "tsx", "jsx",
  "python", "rust", "go", "java", "c", "cpp",
  "csharp", "ruby", "swift", "kotlin", "lua",
  "html", "css", "json", "yaml",
];

function isNoMatchExit(code: number, stdoutText: string, stderrText: string) {
  return code === 1 && !stdoutText && !stderrText;
}

/** Register ast-grep extension tools. */
export default async function register(api: ExtensionAPI) {
  const astGrepBin = await findAstGrepBinary();

  api.registerTool({
    name: "code_search",
    label: "Code Search",
    description: [
      "Search code by AST structure using patterns with metavariables.",
      "Use $VAR for a single AST node, $$$VAR for multiple nodes.",
      "Examples:",
      '  pattern: "console.log($MSG)" — find all console.log calls',
      '  pattern: "if ($COND) { $$$BODY }" — find if-blocks without else',
      '  pattern: "fetch($URL, $OPTS)" — find all fetch calls with 2 args',
      '  pattern: "const $NAME: any = $VAL" — find any-typed const declarations',
      `Supported languages: ${SUPPORTED_LANGS.join(", ")}`,
    ].join("\n"),
    parameters: Type.Object({
      pattern: Type.String({
        description: "AST pattern with metavariables ($VAR for single node, $$$VAR for multiple)",
      }),
      lang: Type.String({
        description: "Language: typescript, python, go, rust, java, etc.",
      }),
      path: Type.Optional(Type.String({
        description: "Directory or file to search (default: workspace root)",
      })),
      limit: Type.Optional(Type.Number({
        description: `Max results to return (default: ${MAX_RESULTS})`,
      })),
    }),
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      const pattern = args.pattern as string;
      const lang = args.lang as string;
      const searchPath = (args.path as string) || ".";
      const limit = (args.limit as number) || MAX_RESULTS;

      const cmdArgs = [
        astGrepBin,
        "run",
        "--pattern", pattern,
        "--lang", lang,
        "--json=stream",
        searchPath,
      ];

      const { stdout, stderr, code } = await withAstGrepProgress(
        ctx,
        `ast-grep: searching ${searchPath} (${lang})…`,
        () => runAstGrep(cmdArgs, signal),
      );
      const stdoutText = stdout.trim();
      const stderrText = stderr.trim();

      if (isNoMatchExit(code, stdoutText, stderrText)) {
        return { content: [{ type: "text" as const, text: "No matches found." }], details: {} };
      }

      if (code !== 0 && !stdoutText && stderrText) {
        return { content: [{ type: "text" as const, text: `Error: ${stderrText}` }], details: {} };
      }

      const lines = stdoutText.split("\n").filter(Boolean);
      const matches: string[] = [];

      for (const line of lines.slice(0, limit)) {
        try {
          const match = JSON.parse(line);
          const file = match.file || "?";
          const startLine = match.range?.start?.line ?? "?";
          const text = (match.text || match.matched || "").trim();
          matches.push(`${file}:${startLine}: ${text}`);
        } catch {
          matches.push(line);
        }
      }

      if (matches.length === 0) {
        return { content: [{ type: "text" as const, text: "No matches found." }], details: {} };
      }

      let output = matches.join("\n");
      if (lines.length > limit) {
        output += `\n\n(showing ${limit} of ${lines.length} matches)`;
      }
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + "\n\n(output truncated)";
      }
      return { content: [{ type: "text" as const, text: output }], details: {} };
    },
  });

  api.registerTool({
    name: "code_rewrite",
    label: "Code Rewrite",
    description: [
      "Structural find-and-replace using AST patterns.",
      "Matches code by structure and replaces using metavariable references.",
      "Examples:",
      '  pattern: "console.log($MSG)" → rewrite: "logger.info($MSG)"',
      '  pattern: "var $NAME = $VAL" → rewrite: "const $NAME = $VAL"',
      "Use dry_run first to preview changes.",
    ].join("\n"),
    parameters: Type.Object({
      pattern: Type.String({
        description: "AST pattern to match (with $VAR metavariables)",
      }),
      rewrite: Type.String({
        description: "Replacement pattern (reference matched $VAR metavariables)",
      }),
      lang: Type.String({
        description: "Language: typescript, python, go, rust, java, etc.",
      }),
      path: Type.Optional(Type.String({
        description: "Directory or file to rewrite (default: workspace root)",
      })),
      dry_run: Type.Optional(Type.Boolean({
        description: "Preview changes without writing (default: true)",
      })),
    }),
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      const pattern = args.pattern as string;
      const rewrite = args.rewrite as string;
      const lang = args.lang as string;
      const searchPath = (args.path as string) || ".";
      const dryRun = args.dry_run !== false;

      const cmdArgs = [
        astGrepBin,
        "run",
        "--pattern", pattern,
        "--rewrite", rewrite,
        "--lang", lang,
        ...(dryRun ? [] : ["--update-all"]),
        searchPath,
      ];

      const { stdout, stderr, code } = await withAstGrepProgress(
        ctx,
        `ast-grep: ${dryRun ? "previewing rewrite" : "rewriting"} ${searchPath} (${lang})…`,
        () => runAstGrep(cmdArgs, signal),
      );
      const stdoutText = stdout.trim();
      const stderrText = stderr.trim();

      if (isNoMatchExit(code, stdoutText, stderrText)) {
        return {
          content: [{
            type: "text" as const,
            text: `${dryRun ? "DRY RUN — preview only (set dry_run: false to apply):\n\n" : "Applied changes:\n\n"}No matches found.`,
          }],
          details: {},
        };
      }

      if (code !== 0 && !stdoutText && stderrText) {
        return { content: [{ type: "text" as const, text: `Error: ${stderrText}` }], details: {} };
      }

      const prefix = dryRun
        ? "DRY RUN — preview only (set dry_run: false to apply):\n\n"
        : "Applied changes:\n\n";
      const raw = stdoutText || "No matches found.";
      const output = raw.length > MAX_OUTPUT_CHARS
        ? raw.slice(0, MAX_OUTPUT_CHARS) + "\n\n(output truncated)"
        : raw;

      return { content: [{ type: "text" as const, text: prefix + output }], details: {} };
    },
  });
}
