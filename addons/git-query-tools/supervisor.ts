/**
 * supervisor.ts — Tool registration for git_history and json_query.
 *
 * Registers both tools with the Pi ExtensionAPI, wiring up schemas,
 * validation, and execute handlers.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { extname } from "node:path";

import { ok, err, collectOutput, stripTrailing } from "./output.js";
import { runProcess } from "./process.js";
import { safePath, relPath, validateText, checkJqExpression, parseBlameLines } from "./validation.js";
import { BASE_DIR, DEFAULT_TIMEOUT, FAST_TIMEOUT } from "./constants.js";

function result(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/* ── git_history ──────────────────────────────────────────────────── */

const TOOL_GIT = "git-history";

async function runGit(args: string[], mode: string, signal?: AbortSignal) {
  const { stdout, stderr, exitCode, signalCode } = await runProcess(
    ["git", ...args],
    { cwd: BASE_DIR, timeout: DEFAULT_TIMEOUT, signal },
  );
  if (signalCode) {
    return err(TOOL_GIT, "History query was killed", {
      meta: { mode, signal: signalCode, timedOut: signalCode === "SIGKILL", timeoutMs: DEFAULT_TIMEOUT },
    });
  }
  if (exitCode !== 0) {
    return err(
      TOOL_GIT,
      stripTrailing(stderr) || stripTrailing(stdout) || `git exited with code ${exitCode}`,
      { meta: { mode, exitCode: exitCode ?? -1 } },
    );
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

/* ── json_query ───────────────────────────────────────────────────── */

const TOOL_JQ = "json-query";

/* ── Extension export ─────────────────────────────────────────────── */

export default function (pi: ExtensionAPI) {
  const gitCheck = Bun.spawnSync(["which", "git"]);
  const jqCheck = Bun.spawnSync(["which", "jq"]);
  if (gitCheck.exitCode !== 0 || jqCheck.exitCode !== 0) {
    console.warn("[git-query-tools] git or jq not found");
  }

  /* git_history */
  pi.registerTool({
    name: "git_history",
    label: "Git History",
    description:
      "Inspect git history: commits, code-history searches, commit-message searches, and blame. Prefer over raw git commands for structured history queries with truncation. Returns JSON envelope.",
    parameters: Type.Object({
      mode: Type.Union(
        [
          Type.Literal("log"),
          Type.Literal("content_search"),
          Type.Literal("message_search"),
          Type.Literal("blame"),
        ],
        { description: "log=recent commits, content_search=string-in-diff, message_search=commit message search, blame=file blame" },
      ),
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

      const checks = [
        validateText(p.query, "query"),
        validateText(p.file, "file"),
        validateText(p.author, "author"),
        validateText(p.since, "since"),
        validateText(p.ref, "ref"),
      ];
      for (const e of checks) if (e) return result(err(TOOL_GIT, e));

      if (p.ref !== undefined && p.ref.trimStart().startsWith("-"))
        return result(err(TOOL_GIT, "'ref' must not start with '-'"));

      if (p.max_count !== undefined && (!Number.isInteger(p.max_count) || p.max_count < 1))
        return result(err(TOOL_GIT, "'max_count' must be a positive integer"));
      if (p.all && p.ref) return result(err(TOOL_GIT, "choose either 'all' or 'ref', not both"));
      if (p.mode === "blame" && p.diff) return result(err(TOOL_GIT, "'diff' not supported in blame"));
      if (p.mode !== "blame" && p.lines) return result(err(TOOL_GIT, "'lines' only for blame mode"));

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

  /* json_query */
  pi.registerTool({
    name: "json_query",
    label: "JSON Query",
    description:
      "Extract, filter, and reshape JSON data with jq expressions. Prefer over shell-based filtering for clearer validation. Returns JSON envelope.",
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

      const exprErr = p.expression !== undefined && !p.expression.trim() ? "'expression' cannot be empty" : undefined;
      if (exprErr) return result(err(TOOL_JQ, exprErr));
      const fileErr = validateText(p.file, "file");
      if (fileErr) return result(err(TOOL_JQ, fileErr));
      const inputErr = p.input !== undefined && !p.input.trim() ? "'input' cannot be empty" : undefined;
      if (inputErr) return result(err(TOOL_JQ, inputErr));

      const hasFile = typeof p.file === "string";
      const hasInput = typeof p.input === "string";
      if (hasFile === hasInput) return result(err(TOOL_JQ, "exactly one of file or input must be provided"));

      let resolvedPath: string | undefined;
      if (hasFile) {
        const { resolved, error } = safePath(p.file!);
        if (error) return result(err(TOOL_JQ, error));
        resolvedPath = resolved;
      }

      const expressionOverridden = p.keys_only && p.expression;
      const expression = p.keys_only ? "keys" : p.expression?.trim();
      if (!expression) return result(err(TOOL_JQ, "expression is required (unless keys_only is true)"));

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

      const warnings = expressionOverridden
        ? [`keys_only=true ignored expression '${p.expression?.trim()}'`]
        : undefined;

      if (signalCode) {
        return result(
          err(TOOL_JQ, "Query killed", {
            meta: { signal: signalCode, timedOut: signalCode === "SIGKILL", timeoutMs: FAST_TIMEOUT },
          }),
        );
      }

      if ((exitCode === 1 || exitCode === 4) && !stderr.trim()) {
        const raw = stripTrailing(stdout);
        if (raw) {
          const { output, totalLines, totalBytes, truncated } = collectOutput(raw);
          const label = exitCode === 1 ? "false/null result" : "empty result";
          return result(
            ok(TOOL_JQ, `Query completed with ${label}`, {
              content: output,
              warnings,
              meta: { totalLines, totalBytes, truncated, expressionOverridden: Boolean(expressionOverridden) },
            }),
          );
        }
        return result(
          ok(TOOL_JQ, exitCode === 1 ? "Result was false or null" : "Empty result set", {
            warnings,
            meta: { expressionOverridden: Boolean(expressionOverridden), truncated: false },
          }),
        );
      }

      if (exitCode !== 0) {
        const msg = stderr.trim() || `exit code ${exitCode}`;
        if (resolvedPath && (msg.includes("parse error") || msg.includes("Invalid"))) {
          const ext = extname(resolvedPath).toLowerCase();
          const hint =
            ext === ".json"
              ? "File may contain invalid JSON."
              : `File extension is '${ext}' — ensure it contains valid JSON.`;
          return result(err(TOOL_JQ, `${msg} ${hint}`, { meta: { exitCode: exitCode ?? -1 } }));
        }
        return result(err(TOOL_JQ, msg, { meta: { exitCode: exitCode ?? -1 } }));
      }

      const trimmed = stripTrailing(stdout);
      if (!trimmed) {
        return result(
          ok(TOOL_JQ, "Empty result", {
            warnings,
            meta: { expressionOverridden: Boolean(expressionOverridden), truncated: false },
          }),
        );
      }

      const { output, totalLines, totalBytes, truncated } = collectOutput(trimmed);
      return result(
        ok(TOOL_JQ, truncated ? "Query completed; truncated" : `Query completed (${totalLines} lines)`, {
          content: output,
          warnings,
          meta: { totalLines, totalBytes, truncated, expressionOverridden: Boolean(expressionOverridden) },
        }),
      );
    },
  });
}
