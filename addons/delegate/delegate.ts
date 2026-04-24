/**
 * delegate.ts — Delegate tasks to a different (typically cheaper/faster) model.
 *
 * Runs `pi --print --model <model> --tools <list>` as a subprocess with its own
 * fresh context, captures the response, and returns it inline. The delegated
 * agent has tool access so it can read files, run commands, grep, etc.
 *
 * The calling agent picks the model automatically based on the task — never
 * choosing a model more capable than the one currently in use.
 *
 * Drop into .pi/extensions/ and /restart.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_OUTPUT_CHARS = 50_000;
const MAX_TEXT_FILE_BYTES = 100_000; // 100KB limit for text file inlining
const WORKSPACE_ROOT = "/workspace";

// Extensions that should NOT be loaded in delegate (UI-only, recursive, or heavy)
const EXCLUDED_EXTENSIONS = new Set([
  "delegate.ts",           // prevent recursion
  "kanban-board-widget.ts", // UI-only
]);

/**
 * Discover the MCP adapter extension path.
 * Cached after first call — result doesn't change during a session.
 */
let _mcpPathCache: string | null | undefined;
function findMcpAdapter(): string | null {
  if (_mcpPathCache !== undefined) return _mcpPathCache;
  const candidates = [
    join(process.env.BUN_INSTALL || "/usr/local/lib/bun", "install/global/node_modules/pi-mcp-adapter/index.ts"),
    "/usr/local/lib/bun/install/global/node_modules/pi-mcp-adapter/index.ts",
  ];
  for (const p of candidates) {
    if (existsSync(p)) { _mcpPathCache = p; return p; }
  }
  _mcpPathCache = null;
  return null;
}

/**
 * Discover workspace extensions safe to load in delegate.
 * Cached after first call — extensions dir rarely changes mid-session.
 */
let _safeExtCache: string[] | undefined;
function findSafeWorkspaceExtensions(): string[] {
  if (_safeExtCache !== undefined) return _safeExtCache;
  const extDir = "/workspace/.pi/extensions";
  if (!existsSync(extDir)) { _safeExtCache = []; return []; }
  try {
    _safeExtCache = readdirSync(extDir)
      .filter((f: string) => f.endsWith(".ts") && !EXCLUDED_EXTENSIONS.has(f))
      .map((f: string) => join(extDir, f));
    return _safeExtCache;
  } catch {
    _safeExtCache = [];
    return [];
  }
}

// ── Model tier system ──────────────────────────────────────────
// Models ranked by capability tier. The delegate must pick a model
// at or below the current model's tier.

interface ModelTier {
  id: string;
  tier: number;
  family: string;
}

// Models ranked by preference within each tier.
// First match in a tier wins — order controls preference.
const MODEL_TIERS: ModelTier[] = [
  // Tier 1: legacy / cheapest
  { id: "github-copilot/gpt-4o",                tier: 1, family: "gpt" },
  { id: "github-copilot/gpt-4.1",               tier: 1, family: "gpt" },
  { id: "github-copilot/claude-haiku-4.5",      tier: 1, family: "claude" },
  { id: "github-copilot/grok-code-fast-1",      tier: 1, family: "grok" },
  // Tier 2: fast & capable — the sweet spot for delegation
  { id: "github-copilot/gpt-5.4-mini",          tier: 2, family: "gpt" },
  { id: "github-copilot/gpt-5.1-codex-mini",    tier: 2, family: "gpt" },
  { id: "github-copilot/gpt-5-mini",            tier: 2, family: "gpt" },
  { id: "github-copilot/gemini-3-flash-preview", tier: 2, family: "gemini" },
  // Tier 3: strong general-purpose
  { id: "github-copilot/claude-sonnet-4.6",     tier: 3, family: "claude" },
  { id: "github-copilot/claude-sonnet-4.5",     tier: 3, family: "claude" },
  { id: "github-copilot/claude-sonnet-4",       tier: 3, family: "claude" },
  { id: "github-copilot/gpt-5.4",               tier: 3, family: "gpt" },
  { id: "github-copilot/gpt-5.2",               tier: 3, family: "gpt" },
  { id: "github-copilot/gpt-5.1",               tier: 3, family: "gpt" },
  { id: "github-copilot/gpt-5",                 tier: 3, family: "gpt" },
  { id: "github-copilot/gemini-3.1-pro-preview", tier: 3, family: "gemini" },
  { id: "github-copilot/gemini-3-pro-preview",   tier: 3, family: "gemini" },
  { id: "github-copilot/gemini-2.5-pro",         tier: 3, family: "gemini" },
  // Tier 4: codex — large context coding specialists
  { id: "github-copilot/gpt-5.3-codex",         tier: 4, family: "gpt" },
  { id: "github-copilot/gpt-5.2-codex",         tier: 4, family: "gpt" },
  { id: "github-copilot/gpt-5.1-codex",         tier: 4, family: "gpt" },
  { id: "github-copilot/gpt-5.1-codex-max",     tier: 4, family: "gpt" },
  // Tier 5: frontier — deep reasoning, complex architecture
  { id: "github-copilot/claude-opus-4.7",       tier: 5, family: "claude" },
  { id: "github-copilot/claude-opus-4.6",       tier: 5, family: "claude" },
  { id: "github-copilot/claude-opus-4.5",       tier: 5, family: "claude" },
];

// O(1) lookup by model ID
const MODEL_TIER_MAP = new Map<string, ModelTier>(MODEL_TIERS.map((m) => [m.id, m]));

function getModelTier(modelId: string): ModelTier | null {
  return MODEL_TIER_MAP.get(modelId) ?? null;
}

function getCurrentTier(ctx: any): number {
  const model = ctx?.model;
  if (!model) return 3; // default to tier 3 if unknown
  const fullId = `${model.provider}/${model.id}`;
  const tier = getModelTier(fullId);
  return tier?.tier ?? 3;
}

type TaskCategory = "quick" | "summarize" | "code" | "analyze" | "reason" | "judge";

// Target tier per category — pick the best model AT this tier,
// falling back to the nearest lower tier if maxTier is below target.
const CATEGORY_TARGET_TIER: Record<TaskCategory, number> = {
  quick: 2,      // gpt-5.4-mini sweet spot
  summarize: 2,  // fast + decent comprehension
  code: 3,       // needs strong reasoning
  analyze: 3,    // needs strong reasoning
  reason: 3,     // strong but NOT frontier — if you need frontier, don't delegate
  judge: 3,      // independent review of main agent's output — different model family preferred
};

const VALID_CATEGORIES = new Set<TaskCategory>(["quick", "summarize", "code", "analyze", "reason", "judge"]);

function selectModel(category: TaskCategory, maxTier: number, currentModelId?: string): string {
  const candidates = MODEL_TIERS.filter((m) => m.tier <= maxTier);
  if (candidates.length === 0) {
    return "github-copilot/gpt-5.4-mini"; // consistent fallback
  }

  // Target tier for this category, capped by maxTier
  const targetTier = Math.min(CATEGORY_TARGET_TIER[category] ?? 2, maxTier);

  // For judge: prefer a different model family than the current agent
  if (category === "judge" && currentModelId) {
    const currentFamily = getModelTier(currentModelId)?.family;
    if (currentFamily) {
      const differentFamily = candidates.find(
        (m) => m.tier === targetTier && m.family !== currentFamily
      );
      if (differentFamily) return differentFamily.id;
      // Fall back to any different-family model at nearby tiers
      for (let t = targetTier; t >= 1; t--) {
        const fb = candidates.find((m) => m.tier === t && m.family !== currentFamily);
        if (fb) return fb.id;
      }
    }
  }

  // Find the best candidate at target tier (first in list = preferred)
  const atTarget = candidates.find((m) => m.tier === targetTier);
  if (atTarget) return atTarget.id;

  // Fall back: closest tier below target, then above
  for (let t = targetTier - 1; t >= 1; t--) {
    const fallback = candidates.find((m) => m.tier === t);
    if (fallback) return fallback.id;
  }

  // Last resort: best available
  return candidates[candidates.length - 1].id;
}

// ── Default tool sets per task profile ─────────────────────────

const TOOL_PROFILES: Record<string, string> = {
  read_only:  "read,grep,find,ls,mcp",
  standard:   "read,grep,find,ls,bash,mcp",
  full:       "read,grep,find,ls,bash,edit,write,mcp",
};

// Binary/image extensions that should be passed as @file args, not read as text
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
  ".svg", ".ico",
  ".pdf",
  ".zip", ".tar", ".gz",
  ".mp3", ".wav", ".mp4", ".webm",
]);

function isBinaryFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/** Validate a resolved path: must be inside workspace, no control characters. */
function validateFilePath(resolved: string, original: string): string | null {
  // Check for control characters (shell injection prevention)
  if (/[\x00-\x1f]/.test(resolved)) {
    return `❌ Unsafe characters in path: ${original}`;
  }
  // Sandbox to workspace root
  if (!resolved.startsWith(WORKSPACE_ROOT + "/") && resolved !== WORKSPACE_ROOT) {
    return `❌ Path outside workspace: ${original} (resolved to ${resolved})`;
  }
  return null; // valid
}

// ── Helpers ────────────────────────────────────────────────────

function result(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ── Extension ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const HINT = [
    "## Delegate tool",
    "Use `delegate` to send a task to a cheaper/faster model and get the result inline.",
    "Saves tokens by not loading the full conversation context into the delegated call.",
    `Default model: \`github-copilot/gpt-5.4-mini\`. Override with the \`model\` parameter.`,
    "Pass file paths in the `files` array to include file contents in the delegated prompt.",
    "The delegate runs in a fresh context (no conversation history, no tools) — pure prompt → response.",
    "Proactively delegate when a task is self-contained and doesn't need conversation history.",
    "When the user asks to 'double check', 'verify', or 'review' your answer, use delegate with task_category='judge' to get a second opinion from a different model family.",
  ].join("\n");

  pi.on("before_agent_start", async (event) => {
    // Auto-activate delegate tool so it's available without manual activate_tools
    const active = pi.getActiveTools();
    if (!active.includes("delegate")) {
      pi.setActiveTools([...active, "delegate"]);
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${HINT}` };
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate to Model",
    description:
      "Delegate a task to a cheaper/faster model in a fresh context. " +
      "The delegate has its own tool access (read, grep, bash, etc.) but no conversation history. " +
      "Use for: summarizing files, quick questions, code generation, data extraction, codebase exploration, " +
      "or any task that doesn't require the full conversation context. " +
      "The model is auto-selected based on the task category — never more capable than the current model.",
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task to delegate. Be specific — the delegate has no conversation history.",
      }),
      task_category: Type.Optional(
        Type.Union([
          Type.Literal("quick",     { description: "Fast/simple: formatting, extraction, translation, factual Q&A" }),
          Type.Literal("summarize", { description: "Summarize files, notes, code, or text" }),
          Type.Literal("code",      { description: "Code generation, refactoring, or mechanical edits" }),
          Type.Literal("analyze",   { description: "Code review, architecture analysis, debugging" }),
          Type.Literal("reason",    { description: "Complex reasoning, planning, multi-step logic" }),
          Type.Literal("judge",     { description: "Review/critique the main agent's last response — uses a different model family" }),
        ], {
          description: "Task category for auto model selection. Default: summarize",
        })
      ),
      model: Type.Optional(
        Type.String({
          description: "Explicit model override (provider/id). Skips auto-selection.",
        })
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: "File paths to include as context in the prompt.",
        })
      ),
      tools: Type.Optional(
        Type.Union([
          Type.Literal("read_only", { description: "read, grep, find, ls, mcp" }),
          Type.Literal("standard",  { description: "read, grep, find, ls, bash, mcp (default)" }),
          Type.Literal("full",      { description: "read, grep, find, ls, bash, edit, write, mcp" }),
          Type.String({ description: "Comma-separated tool names" }),
        ], {
          description: "Tool profile or explicit list. Default: standard (read, grep, find, ls, bash)",
        })
      ),
      system_prompt: Type.Optional(
        Type.String({
          description: "Custom system prompt override.",
        })
      ),
      timeout_sec: Type.Optional(
        Type.Integer({
          description: `Timeout in seconds. Default: ${DEFAULT_TIMEOUT_SEC}`,
          minimum: 5,
          maximum: 300,
        })
      ),
    }),

    async execute(_toolCallId, params, signal, _update, ctx) {
      // #13: Validate category
      const rawCategory = (params.task_category as TaskCategory) || "summarize";
      const category: TaskCategory = VALID_CATEGORIES.has(rawCategory) ? rawCategory : "summarize";
      const maxTier = getCurrentTier(ctx);

      // Model selection
      const currentModelId = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const model = params.model || selectModel(category, maxTier, currentModelId);

      const timeout = params.timeout_sec || DEFAULT_TIMEOUT_SEC;

      // Resolve tools
      const toolsArg = params.tools
        ? (TOOL_PROFILES[params.tools] || params.tools)
        : TOOL_PROFILES.standard;

      // Separate files into text (inline in prompt) and binary (pass as @file args)
      let fullPrompt = params.prompt;
      const attachmentArgs: string[] = []; // @file args for binary/image files
      let hasVisualInput = false;

      if (params.files && params.files.length > 0) {
        const textContents: string[] = [];
        for (const filePath of params.files) {
          const resolved = resolve(filePath);
          // Security: validate path
          const pathError = validateFilePath(resolved, filePath);
          if (pathError) return result(pathError);
          if (!existsSync(resolved)) {
            return result(`❌ File not found: ${filePath}`);
          }
          if (isBinaryFile(filePath)) {
            // Binary/image files: pass as @file positional arg to pi
            attachmentArgs.push(`@${resolved}`);
            hasVisualInput = true;
          } else {
            // Text files: inline in prompt (with size limit)
            try {
              const stat = statSync(resolved);
              if (stat.size > MAX_TEXT_FILE_BYTES) {
                return result(`❌ File too large for inlining: ${filePath} (${(stat.size / 1024).toFixed(0)}KB, max ${MAX_TEXT_FILE_BYTES / 1024}KB). Use the delegate's tools to read it instead.`);
              }
              const content = readFileSync(resolved, "utf-8");
              textContents.push(`\n--- ${filePath} ---\n${content}\n---`);
            } catch (err) {
              return result(
                `❌ Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        }
        if (textContents.length > 0) {
          fullPrompt = `${fullPrompt}\n\nFile contents:${textContents.join("\n")}`;
        }
      }

      // Modality-aware tier bumping: if visual input detected and target tier < 3, bump to 3
      let effectiveModel = model;
      if (hasVisualInput && !params.model) {
        const modelTier = getModelTier(model);
        if (modelTier && modelTier.tier < 3) {
          // Override category to 'analyze' for visual input — forces tier 3 selection
          effectiveModel = selectModel("analyze", maxTier, currentModelId);
        }
      }

      // Build pi args (direct spawn, no shell wrapper)
      const piArgs: string[] = [
        "--print",
        "--no-extensions",
        "--model", effectiveModel,
        "--tools", toolsArg,
      ];

      // Load MCP adapter + safe workspace extensions
      const mcpPath = findMcpAdapter();
      if (mcpPath) {
        piArgs.push("-e", mcpPath);
      }
      for (const ext of findSafeWorkspaceExtensions()) {
        piArgs.push("-e", ext);
      }

      // Append capability hints so cheap models know what tools are available
      const capabilityHints = [
        "Web search: run 'bun /workspace/.pi/skills/web-search/web-search.ts --query \"QUERY\" --fetch true --fetch-limit 3' to search the web.",
        "Web search summary: run 'bun /workspace/.pi/skills/web-search-summary/web-search-summary.ts --query \"QUERY\"' for summarized results.",
        "MCP: use the mcp tool with action 'call_tool' to call MCP server tools.",
      ].join("\n");
      piArgs.push("--append-system-prompt", capabilityHints);

      if (params.system_prompt) {
        piArgs.push("--system-prompt", params.system_prompt);
      }

      // Add @file args for binary/image attachments
      for (const att of attachmentArgs) {
        piArgs.push(att);
      }

      // Execute delegate subprocess (async with abort signal support)
      try {
        const { stdout, stderr, exitCode } = await runDelegateProcess(piArgs, fullPrompt, timeout, signal);

        if (exitCode !== 0 && !stdout.trim()) {
          const errMsg = stderr.trim() || `Process exited with code ${exitCode}`;
          return result(`❌ Delegate failed (model: ${effectiveModel}): ${errMsg}`);
        }

        const trimmed = stdout.trim();
        if (!trimmed) {
          return result(`⚠️ Delegate returned empty response (model: ${effectiveModel}).`);
        }

        const truncated =
          trimmed.length > MAX_OUTPUT_CHARS
            ? trimmed.slice(0, MAX_OUTPUT_CHARS) + `\n\n[truncated at ${MAX_OUTPUT_CHARS} chars]`
            : trimmed;

        return result(`**Delegated to \`${effectiveModel}\` [${category}]:**\n\n${truncated}`);
      } catch (err: any) {
        if (err.name === "AbortError" || signal?.aborted) {
          return result(`❌ Delegate aborted (model: ${effectiveModel}).`);
        }
        if (err.message?.includes("timed out")) {
          return result(`❌ Delegate timed out after ${timeout}s (model: ${effectiveModel}).`);
        }

        return result(`❌ Delegate failed (model: ${effectiveModel}): ${err.message || String(err)}`);
      }
    },
  });
}

/** Run pi directly as a child process with stdin prompt, abort + timeout support. */
function runDelegateProcess(
  piArgs: string[],
  prompt: string,
  timeoutSec: number,
  signal?: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn("pi", piArgs, {
      cwd: "/workspace",
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    // Cap buffered output to prevent memory blowup
    const MAX_BUFFER = MAX_OUTPUT_CHARS * 2;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk.toString();
    });

    // Write prompt to stdin and close it
    child.stdin?.write(prompt);
    child.stdin?.end();

    function cleanup() {
      clearTimeout(timer);
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      signal?.removeEventListener("abort", onAbort);
    }

    function killChild(reason: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      try { child.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
      reject(reason);
    }

    // Timeout
    const timer = setTimeout(() => {
      killChild(new Error(`timed out after ${timeoutSec}s`));
    }, timeoutSec * 1000);

    // Abort signal
    const onAbort = () => {
      const err = new Error("Aborted"); err.name = "AbortError";
      killChild(err);
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, exitCode: code });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}
