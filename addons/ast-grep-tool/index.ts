/**
 * ast-grep-tool — Structural code search and rewrite via ast-grep.
 *
 * Registers two tools:
 *   code_search  — find code by AST pattern with metavariables
 *   code_rewrite — structural find-and-replace
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const WORKSPACE_ROOT = "/workspace";
const MAX_RESULTS = 100;
const MAX_OUTPUT_CHARS = 30_000;

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

/** Register ast-grep extension tools. */
export default async function register(api: ExtensionAPI) {
  const astGrepBin = await findAstGrepBinary();

  api.registerTool({
    name: "code_search",
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
    async execute(_toolCallId, args, signal) {
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

      const { stdout, stderr, code } = await runAstGrep(cmdArgs, signal);

      if (code !== 0 && !stdout) {
        return { content: [{ type: "text" as const, text: `Error: ${stderr || `ast-grep exited with code ${code}`}` }] };
      }

      const lines = stdout.trim().split("\n").filter(Boolean);
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
        return { content: [{ type: "text" as const, text: `No matches found for pattern: ${pattern}` }] };
      }

      let output = matches.join("\n");
      if (lines.length > limit) {
        output += `\n\n(showing ${limit} of ${lines.length} matches)`;
      }
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + "\n\n(output truncated)";
      }
      return { content: [{ type: "text" as const, text: output }] };
    },
  });

  api.registerTool({
    name: "code_rewrite",
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
    async execute(_toolCallId, args, signal) {
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

      const { stdout, stderr, code } = await runAstGrep(cmdArgs, signal);

      if (code !== 0 && !stdout) {
        return { content: [{ type: "text" as const, text: `Error: ${stderr || `ast-grep exited with code ${code}`}` }] };
      }

      const prefix = dryRun
        ? "DRY RUN — preview only (set dry_run: false to apply):\n\n"
        : "Applied changes:\n\n";
      const raw = stdout.trim() || "No matches found.";
      const output = raw.length > MAX_OUTPUT_CHARS
        ? raw.slice(0, MAX_OUTPUT_CHARS) + "\n\n(output truncated)"
        : raw;

      return { content: [{ type: "text" as const, text: prefix + output }] };
    },
  });
}
