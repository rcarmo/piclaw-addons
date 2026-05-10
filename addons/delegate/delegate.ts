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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_OUTPUT_CHARS = 50_000;
const DELEGATE_STATUS_KEY = "delegate";
const MAX_TEXT_FILE_BYTES = 100_000; // 100KB limit for text file inlining
const WORKSPACE_ROOT = "/workspace";

// Extensions that should NOT be loaded in delegate (UI-only, recursive, or heavy)
const EXCLUDED_EXTENSIONS = new Set([
  "delegate.ts",           // prevent recursion
  "kanban-board-widget.ts", // UI-only
]);

const EXTENSION_ID = "delegate";
const AZURE_PROVIDER_RE = /^azure-/i;
const DEFAULT_SEARCHABLE_PROVIDER_ORDER = ["anthropic", "openai", "openai-codex", "google", "github-copilot"];
const MIN_MODEL_MATCH_SCORE = 75;

export interface DelegateConfig {
  searchable_providers: string[] | null;
}

const DEFAULT_CONFIG: DelegateConfig = {
  searchable_providers: null, // null = all discovered non-azure providers; [] = intentionally disabled
};

let storage: ExtensionStorage | null = null;
function kv(): ExtensionStorage {
  if (!storage) storage = createExtensionStorage(EXTENSION_ID);
  return storage;
}

function loadConfig(): DelegateConfig {
  try {
    const saved = kv().get<Partial<DelegateConfig>>("config", "global");
    if (saved) return { ...DEFAULT_CONFIG, ...saved };
  } catch { /* first run */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: DelegateConfig): void {
  kv().set("config", config, "global");
}

function normalizeProviderList(values: unknown): string[] | null {
  if (values == null) return null;
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => value && !AZURE_PROVIDER_RE.test(value)))]
    .sort((a, b) => a.localeCompare(b));
}

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

export interface AvailableModel {
  provider: string;
  id: string;
  fullId: string;
  context?: string;
  maxOut?: string;
  thinking?: string;
  images?: string;
}

interface ModelCandidate extends ModelTier {
  sourceId: string;
  provider: string;
  modelId: string;
  matchScore: number;
}

function getModelTier(modelId: string): ModelTier | null {
  return MODEL_TIER_MAP.get(modelId) ?? null;
}

function normalizeModelName(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/^github-copilot\//, "")
    .replace(/^openai\//, "")
    .replace(/^anthropic\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function modelTokens(value: string): string[] {
  return normalizeModelName(value).split("-").filter(Boolean);
}

function familyFromModelId(modelId: string): string {
  const normalized = normalizeModelName(modelId);
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("gpt") || normalized.includes("o1") || normalized.includes("o3") || normalized.includes("o4")) return "gpt";
  if (normalized.includes("gemini")) return "gemini";
  if (normalized.includes("grok")) return "grok";
  if (normalized.includes("llama")) return "llama";
  if (normalized.includes("qwen")) return "qwen";
  return normalized.split("-")[0] || "unknown";
}

export function modelSimilarityScore(referenceModelId: string, candidateModelId: string): number {
  const ref = normalizeModelName(referenceModelId);
  const candidate = normalizeModelName(candidateModelId);
  if (!ref || !candidate) return 0;
  if (ref === candidate) return 100;
  if (candidate.startsWith(ref) || ref.startsWith(candidate)) return 90;
  const refTokens = new Set(modelTokens(ref));
  const candidateTokens = new Set(modelTokens(candidate));
  if (!refTokens.size || !candidateTokens.size) return 0;
  const intersection = [...refTokens].filter((token) => candidateTokens.has(token)).length;
  const union = new Set([...refTokens, ...candidateTokens]).size;
  const jaccard = intersection / union;
  const familyBonus = familyFromModelId(ref) === familyFromModelId(candidate) ? 12 : 0;
  const versionBonus = [...refTokens].some((token) => /^\d+$/.test(token) && candidateTokens.has(token)) ? 8 : 0;
  return Math.round((jaccard * 80) + familyBonus + versionBonus);
}

function isCompatibleModelMatch(referenceModelId: string, candidateModelId: string): boolean {
  const referenceTokens = new Set(modelTokens(referenceModelId));
  const candidateTokens = new Set(modelTokens(candidateModelId));
  if (familyFromModelId(referenceModelId) !== familyFromModelId(candidateModelId)) return false;
  const requiredVariantGroups = [
    ["haiku", "sonnet", "opus"],
    ["mini"],
    ["codex"],
    ["flash"],
    ["pro"],
  ];
  for (const group of requiredVariantGroups) {
    const referenceVariant = group.find((token) => referenceTokens.has(token));
    if (referenceVariant && !candidateTokens.has(referenceVariant)) return false;
  }
  return true;
}

function providerPreference(provider: string, searchableProviders: string[] | null): number {
  const configured = searchableProviders?.indexOf(provider) ?? -1;
  if (configured >= 0) return configured;
  const preferred = DEFAULT_SEARCHABLE_PROVIDER_ORDER.indexOf(provider);
  if (preferred >= 0) return preferred;
  return 100 + provider.localeCompare("github-copilot");
}

function getAllowedProviders(models: AvailableModel[], config: DelegateConfig): string[] {
  const discovered = [...new Set(models.map((model) => model.provider).filter((provider) => !AZURE_PROVIDER_RE.test(provider)))].sort();
  const configured = normalizeProviderList(config.searchable_providers);
  if (configured === null) return discovered;
  const discoveredSet = new Set(discovered);
  return configured.filter((provider) => discoveredSet.has(provider));
}

export function buildModelCandidates(models: AvailableModel[], config: DelegateConfig = DEFAULT_CONFIG): ModelCandidate[] {
  const allowedProviders = new Set(getAllowedProviders(models, config));
  const candidates: ModelCandidate[] = [];
  for (const reference of MODEL_TIERS) {
    const referenceModelId = reference.id.split("/").slice(1).join("/");
    const referenceProvider = reference.id.split("/", 1)[0] || "";
    const matches = models
      .filter((model) => !AZURE_PROVIDER_RE.test(model.provider) && allowedProviders.has(model.provider))
      .map((model) => ({ model, score: modelSimilarityScore(referenceModelId, model.id) }))
      .filter(({ model, score }) =>
        (score >= MIN_MODEL_MATCH_SCORE && isCompatibleModelMatch(referenceModelId, model.id)) ||
        (model.provider === referenceProvider && model.id === referenceModelId)
      )
      .sort((a, b) => {
        const byScore = b.score - a.score;
        if (byScore !== 0) return byScore;
        const byProvider = providerPreference(a.model.provider, config.searchable_providers) - providerPreference(b.model.provider, config.searchable_providers);
        if (byProvider !== 0) return byProvider;
        return a.model.fullId.localeCompare(b.model.fullId);
      });
    for (const match of matches) {
      candidates.push({
        id: match.model.fullId,
        tier: reference.tier,
        family: reference.family,
        sourceId: reference.id,
        provider: match.model.provider,
        modelId: match.model.id,
        matchScore: match.score,
      });
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.id}:${candidate.tier}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferModelTier(modelId: string, candidates: ModelCandidate[]): ModelTier | null {
  const exact = getModelTier(modelId);
  if (exact) return exact;
  const [, currentModelName = modelId] = modelId.split(/\/(.+)/);
  const match = candidates
    .map((candidate) => ({ candidate, score: modelSimilarityScore(candidate.modelId, currentModelName) }))
    .filter(({ score }) => score >= MIN_MODEL_MATCH_SCORE)
    .sort((a, b) => b.score - a.score || b.candidate.tier - a.candidate.tier)[0]?.candidate;
  return match ? { id: modelId, tier: match.tier, family: match.family } : null;
}

function getCurrentTier(ctx: any, candidates: ModelCandidate[] = []): number {
  const model = ctx?.model;
  if (!model) return 3; // default to tier 3 if unknown
  const fullId = `${model.provider}/${model.id}`;
  const tier = inferModelTier(fullId, candidates);
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

function selectModel(category: TaskCategory, maxTier: number, currentModelId?: string, discoveredCandidates: ModelCandidate[] = []): string {
  const sourceCandidates = discoveredCandidates.length > 0 ? discoveredCandidates : MODEL_TIERS.map((model) => ({
    ...model,
    sourceId: model.id,
    provider: model.id.split("/", 1)[0] || "",
    modelId: model.id.split("/").slice(1).join("/"),
    matchScore: 100,
  }));
  const candidates = sourceCandidates.filter((m) => m.tier <= maxTier && !AZURE_PROVIDER_RE.test(m.provider));
  if (candidates.length === 0) {
    return "github-copilot/gpt-5.4-mini"; // consistent fallback
  }

  // Target tier for this category, capped by maxTier
  const targetTier = Math.min(CATEGORY_TARGET_TIER[category] ?? 2, maxTier);

  // For judge: prefer a different model family than the current agent
  if (category === "judge" && currentModelId) {
    const currentFamily = inferModelTier(currentModelId, discoveredCandidates)?.family;
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

// ── Model discovery ────────────────────────────────────────────

export function parsePiListModelsOutput(output: string): AvailableModel[] {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const models: AvailableModel[] = [];
  for (const line of lines) {
    if (/^provider\s+model\s+/i.test(line)) continue;
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const [provider, id, context, maxOut, thinking, images] = parts;
    if (!provider || !id) continue;
    models.push({ provider, id, fullId: `${provider}/${id}`, context, maxOut, thinking, images });
  }
  return models;
}

function runPiListModels(timeoutMs = 20_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = nodeSpawn("pi", ["--list-models"], {
      cwd: "/workspace",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      reject(new Error("pi --list-models timed out"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `pi --list-models exited ${code}`));
      else resolvePromise(stdout);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

let discoveredModelsCache: AvailableModel[] | null = null;
async function getDiscoveredModels(refresh = false): Promise<AvailableModel[]> {
  if (!refresh && discoveredModelsCache) return discoveredModelsCache;
  try {
    const output = await runPiListModels();
    discoveredModelsCache = parsePiListModelsOutput(output);
    return discoveredModelsCache;
  } catch {
    discoveredModelsCache = [];
    return [];
  }
}

async function getModelCandidates(config: DelegateConfig, refresh = false): Promise<ModelCandidate[]> {
  const models = await getDiscoveredModels(refresh);
  return buildModelCandidates(models, config);
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

export function delegateTaskPreview(prompt: string, maxLength = 96): string {
  const collapsed = String(prompt || "").replace(/\s+/g, " ").trim();
  if (!collapsed) return "delegated task";
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

function setDelegateProgress(ctx: any, options: { model: string; category: TaskCategory; prompt: string }): void {
  const preview = delegateTaskPreview(options.prompt);
  const message = `Delegating ${options.category} to ${options.model}: ${preview}`;
  try { ctx?.ui?.setStatus?.(DELEGATE_STATUS_KEY, `🤝 ${message}`); } catch { /* UI may not support status in all modes */ }
  try { ctx?.ui?.setWorkingMessage?.(message); } catch { /* UI may not support working messages in all modes */ }
}

function clearDelegateProgress(ctx: any): void {
  try { ctx?.ui?.setStatus?.(DELEGATE_STATUS_KEY, undefined); } catch { /* ignore */ }
  try { ctx?.ui?.setWorkingMessage?.(undefined); } catch { /* ignore */ }
}

// ── Settings API ───────────────────────────────────────────────

type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: { get?: (payload: unknown, req: Request) => unknown | Promise<unknown>; set?: (payload: unknown, req: Request) => unknown | Promise<unknown> },
  extensionPath?: string,
) => "created" | "updated";

function providerSummaries(models: AvailableModel[], config: DelegateConfig) {
  const enabled = new Set(getAllowedProviders(models, config));
  const providers = [...new Set(models.map((model) => model.provider))].sort();
  return providers.map((provider) => ({
    provider,
    enabled: !AZURE_PROVIDER_RE.test(provider) && enabled.has(provider),
    blacklisted: AZURE_PROVIDER_RE.test(provider),
    modelCount: models.filter((model) => model.provider === provider).length,
  }));
}

async function handleGetModels(refresh = false) {
  const config = loadConfig();
  const models = await getDiscoveredModels(refresh);
  const candidates = buildModelCandidates(models, config);
  return {
    ok: true,
    config,
    providers: providerSummaries(models, config),
    models,
    candidates: candidates.map(({ id, tier, family, sourceId, provider, modelId, matchScore }) => ({ id, tier, family, sourceId, provider, modelId, matchScore })),
  };
}

const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
if (typeof registerAddonConfigApi === "function") {
  registerAddonConfigApi(EXTENSION_ID, "config", {
    get: async () => ({ ok: true, config: loadConfig() }),
    set: async (payload) => {
      const body = payload && typeof payload === "object" ? payload as Partial<DelegateConfig> : {};
      const next = { ...loadConfig(), searchable_providers: normalizeProviderList(body.searchable_providers) };
      saveConfig(next);
      return { ok: true, config: next };
    },
  }, import.meta.dir);
  registerAddonConfigApi(EXTENSION_ID, "models", {
    get: async () => handleGetModels(false),
    set: async () => handleGetModels(true),
  }, import.meta.dir);
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
    "When you call delegate, produce a visible one-sentence timeline update that says what you are delegating and why; do not leave the user with zero feedback while the delegated process runs.",
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
      const config = loadConfig();
      const discoveredCandidates = await getModelCandidates(config);
      if (!params.model && Array.isArray(config.searchable_providers) && discoveredCandidates.length === 0) {
        return result("❌ No delegate model candidates found for the selected providers. Enable at least one searchable provider or refresh the model list in Delegate settings.");
      }
      const maxTier = getCurrentTier(ctx, discoveredCandidates);

      // Model selection
      const currentModelId = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const model = params.model || selectModel(category, maxTier, currentModelId, discoveredCandidates);

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
        const modelTier = inferModelTier(model, discoveredCandidates);
        if (modelTier && modelTier.tier < 3) {
          // Override category to 'analyze' for visual input — forces tier 3 selection
          effectiveModel = selectModel("analyze", maxTier, currentModelId, discoveredCandidates);
        }
      }

      setDelegateProgress(ctx, { model: effectiveModel, category, prompt: params.prompt });

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
      } finally {
        clearDelegateProgress(ctx);
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
