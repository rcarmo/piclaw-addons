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
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_OUTPUT_CHARS = 50_000;

// Extensions that should NOT be loaded in delegate (UI-only, recursive, or heavy)
const EXCLUDED_EXTENSIONS = new Set([
  "delegate.ts",           // prevent recursion
  "kanban-board-widget.ts", // UI-only
]);

/**
 * Discover the MCP adapter extension path.
 * Checks known global install locations; returns null if not found.
 */
function findMcpAdapter(): string | null {
  const candidates = [
    join(process.env.BUN_INSTALL || "/usr/local/lib/bun", "install/global/node_modules/pi-mcp-adapter/index.ts"),
    "/usr/local/lib/bun/install/global/node_modules/pi-mcp-adapter/index.ts",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Discover workspace extensions safe to load in delegate.
 * Auto-includes any .ts file in .pi/extensions/ not in the exclusion set.
 */
function findSafeWorkspaceExtensions(): string[] {
  const extDir = "/workspace/.pi/extensions";
  if (!existsSync(extDir)) return [];
  try {
    return readdirSync(extDir)
      .filter((f: string) => f.endsWith(".ts") && !EXCLUDED_EXTENSIONS.has(f))
      .map((f: string) => join(extDir, f));
  } catch {
    return [];
  }
}

// ── Model tier system ──────────────────────────────────────────
// Models ranked by capability tier. The delegate must pick a model
// at or below the current model's tier.

interface ModelTier {
  id: string;
  tier: number;     // lower = cheaper/faster
  family: string;   // for matching
  speed: "fast" | "medium" | "slow";
  strength: "light" | "medium" | "strong" | "frontier";
}

// Tier mapping for github-copilot models (add more as needed)
const MODEL_TIERS: ModelTier[] = [
  // Tier 1: fast & cheap — quick tasks, formatting, extraction
  { id: "github-copilot/gpt-4o",              tier: 1, family: "gpt",      speed: "fast",   strength: "light" },
  { id: "github-copilot/gpt-4.1",             tier: 1, family: "gpt",      speed: "fast",   strength: "light" },
  { id: "github-copilot/claude-haiku-4.5",    tier: 1, family: "claude",   speed: "fast",   strength: "light" },
  { id: "github-copilot/grok-code-fast-1",    tier: 1, family: "grok",     speed: "fast",   strength: "light" },
  // Tier 2: balanced — summarization, code gen, analysis
  { id: "github-copilot/gpt-5-mini",          tier: 2, family: "gpt",      speed: "fast",   strength: "medium" },
  { id: "github-copilot/gpt-5.4-mini",        tier: 2, family: "gpt",      speed: "fast",   strength: "medium" },
  { id: "github-copilot/gpt-5.1-codex-mini",  tier: 2, family: "gpt",      speed: "fast",   strength: "medium" },
  { id: "github-copilot/gemini-3-flash-preview", tier: 2, family: "gemini", speed: "fast",  strength: "medium" },
  // Tier 3: capable — reasoning, multi-step, code review
  { id: "github-copilot/claude-sonnet-4",     tier: 3, family: "claude",   speed: "medium", strength: "medium" },
  { id: "github-copilot/claude-sonnet-4.5",   tier: 3, family: "claude",   speed: "medium", strength: "medium" },
  { id: "github-copilot/claude-sonnet-4.6",   tier: 3, family: "claude",   speed: "medium", strength: "medium" },
  { id: "github-copilot/gpt-5",               tier: 3, family: "gpt",      speed: "medium", strength: "medium" },
  { id: "github-copilot/gpt-5.1",             tier: 3, family: "gpt",      speed: "medium", strength: "medium" },
  { id: "github-copilot/gpt-5.2",             tier: 3, family: "gpt",      speed: "medium", strength: "medium" },
  { id: "github-copilot/gpt-5.4",             tier: 3, family: "gpt",      speed: "medium", strength: "medium" },
  { id: "github-copilot/gemini-2.5-pro",      tier: 3, family: "gemini",   speed: "medium", strength: "medium" },
  { id: "github-copilot/gemini-3-pro-preview", tier: 3, family: "gemini",  speed: "medium", strength: "medium" },
  { id: "github-copilot/gemini-3.1-pro-preview", tier: 3, family: "gemini", speed: "medium", strength: "medium" },
  // Tier 4: codex — large context coding specialists
  { id: "github-copilot/gpt-5.1-codex",       tier: 4, family: "gpt",      speed: "medium", strength: "strong" },
  { id: "github-copilot/gpt-5.1-codex-max",   tier: 4, family: "gpt",      speed: "slow",   strength: "strong" },
  { id: "github-copilot/gpt-5.2-codex",       tier: 4, family: "gpt",      speed: "medium", strength: "strong" },
  { id: "github-copilot/gpt-5.3-codex",       tier: 4, family: "gpt",      speed: "medium", strength: "strong" },
  // Tier 5: frontier — deep reasoning, complex architecture
  { id: "github-copilot/claude-opus-4.5",     tier: 5, family: "claude",   speed: "slow",   strength: "frontier" },
  { id: "github-copilot/claude-opus-4.6",     tier: 5, family: "claude",   speed: "slow",   strength: "frontier" },
  { id: "github-copilot/claude-opus-4.7",     tier: 5, family: "claude",   speed: "slow",   strength: "frontier" },
];

function getModelTier(modelId: string): ModelTier | null {
  return MODEL_TIERS.find((m) => m.id === modelId) ?? null;
}

function getCurrentTier(ctx: any): number {
  const model = ctx?.model;
  if (!model) return 3; // default to tier 3 if unknown
  const fullId = `${model.provider}/${model.id}`;
  const tier = getModelTier(fullId);
  return tier?.tier ?? 3;
}

type TaskCategory = "quick" | "summarize" | "code" | "analyze" | "reason";

function selectModel(category: TaskCategory, maxTier: number): string {
  // Pick the best model for the category that doesn't exceed maxTier
  const candidates = MODEL_TIERS.filter((m) => m.tier <= maxTier);
  if (candidates.length === 0) {
    return MODEL_TIERS[0]?.id || "github-copilot/gpt-5.4-mini";
  }

  // For each category, prefer certain characteristics
  switch (category) {
    case "quick":
      // Fastest available
      return (
        candidates.find((m) => m.speed === "fast" && m.tier <= 2) ??
        candidates.find((m) => m.speed === "fast") ??
        candidates[0]
      ).id;

    case "summarize":
      // Fast but needs decent comprehension
      return (
        candidates.find((m) => m.tier === 2) ??
        candidates.find((m) => m.speed === "fast") ??
        candidates[0]
      ).id;

    case "code":
      // Best coding model available within budget
      return (
        candidates.find((m) => m.family === "gpt" && m.tier >= 2 && m.tier <= Math.min(maxTier, 4)) ??
        candidates.find((m) => m.tier === Math.min(maxTier, 3)) ??
        candidates[candidates.length - 1]
      ).id;

    case "analyze":
      // Needs reasoning but not frontier
      return (
        candidates.find((m) => m.strength === "medium" && m.tier >= 2) ??
        candidates.find((m) => m.tier === Math.min(maxTier, 3)) ??
        candidates[candidates.length - 1]
      ).id;

    case "reason":
      // Best available within budget
      return candidates[candidates.length - 1].id;

    default:
      // Default: tier 2 balanced
      return (
        candidates.find((m) => m.tier === 2) ??
        candidates[0]
      ).id;
  }
}

// ── Default tool sets per task profile ─────────────────────────

const TOOL_PROFILES: Record<string, string> = {
  read_only:  "read,grep,find,ls,mcp",
  standard:   "read,grep,find,ls,bash,mcp",
  full:       "read,grep,find,ls,bash,edit,write,mcp",
};

// ── Helpers ────────────────────────────────────────────────────

function result(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
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
  ].join("\n");

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${HINT}`,
  }));

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

    async execute(_toolCallId, params, _signal, _update, ctx) {
      const category: TaskCategory = (params.task_category as TaskCategory) || "summarize";
      const maxTier = getCurrentTier(ctx);

      // Model selection
      const model = params.model || selectModel(category, maxTier);

      const timeout = params.timeout_sec || DEFAULT_TIMEOUT_SEC;

      // Resolve tools
      const toolsArg = params.tools
        ? (TOOL_PROFILES[params.tools] || params.tools)
        : TOOL_PROFILES.standard;

      // Build the prompt with optional file contents
      let fullPrompt = params.prompt;

      if (params.files && params.files.length > 0) {
        const fileContents: string[] = [];
        for (const filePath of params.files) {
          const resolved = resolve(filePath);
          if (!existsSync(resolved)) {
            return result(`❌ File not found: ${filePath}`);
          }
          try {
            const content = readFileSync(resolved, "utf-8");
            fileContents.push(`\n--- ${filePath} ---\n${content}\n---`);
          } catch (err) {
            return result(
              `❌ Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        fullPrompt = `${fullPrompt}\n\nFile contents:${fileContents.join("\n")}`;
      }

      // Build pi command
      const args: string[] = [
        "pi", "--print",
        "--no-extensions",
        "--model", model,
        "--tools", toolsArg,
      ];

      // Load MCP adapter + safe workspace extensions
      const mcpPath = findMcpAdapter();
      if (mcpPath) {
        args.push("-e", mcpPath);
      }
      for (const ext of findSafeWorkspaceExtensions()) {
        args.push("-e", ext);
      }

      if (params.system_prompt) {
        args.push("--system-prompt", params.system_prompt);
      }

      // Write prompt to temp file to avoid shell escaping issues
      const tmpFile = `/tmp/delegate-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
      writeFileSync(tmpFile, fullPrompt, "utf-8");

      const cmd = `cat ${shellQuote(tmpFile)} | ${args.map(shellQuote).join(" ")}`;

      try {
        const output = execSync(cmd, {
          encoding: "utf-8",
          timeout: timeout * 1000,
          maxBuffer: 10 * 1024 * 1024,
          cwd: "/workspace",
          stdio: ["pipe", "pipe", "pipe"],
        });

        try { unlinkSync(tmpFile); } catch {}

        const trimmed = output.trim();
        if (!trimmed) {
          return result(`⚠️ Delegate returned empty response (model: ${model}).`);
        }

        const truncated =
          trimmed.length > MAX_OUTPUT_CHARS
            ? trimmed.slice(0, MAX_OUTPUT_CHARS) + `\n\n[truncated at ${MAX_OUTPUT_CHARS} chars]`
            : trimmed;

        return result(`**Delegated to \`${model}\` [${category}]:**\n\n${truncated}`);
      } catch (err: any) {
        try { unlinkSync(tmpFile); } catch {}

        if (err.killed || err.signal === "SIGTERM") {
          return result(`❌ Delegate timed out after ${timeout}s (model: ${model}).`);
        }

        const stderr = err.stderr?.trim() || "";
        const stdout = err.stdout?.trim() || "";
        const message = err.message || String(err);

        // Some models/errors still produce useful output on stdout
        if (stdout && stdout.length > 20) {
          return result(`**Delegated to \`${model}\` [${category}]:**\n\n${stdout}`);
        }

        return result(`❌ Delegate failed (model: ${model}): ${stderr || message}`);
      }
    },
  });
}
