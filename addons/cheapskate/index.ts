/**
 * piclaw-addon-cheapskate — Free-tier provider rotation as a single selectable model.
 *
 * Registers a `cheapskate` provider with an `auto` model. When selected,
 * it transparently routes requests to the best available free-tier backend
 * and rotates on rate-limit errors.
 *
 * Config at .pi/cheapskate.json — the web settings pane and this extension
 * both read it. Backends can be individually enabled/disabled and soft-cap
 * providers (Cloudflare) have a safety-cap toggle.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";

// ── Free-tier backend definitions ────────────────────────────────

interface FreeBackend {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  modelId: string;
  modelName: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
  tokensPerDay: number;
  hasSoftCap?: boolean;
}

const BACKENDS: FreeBackend[] = [
  {
    id: "google", name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    modelId: "gemini-2.5-flash", modelName: "Gemini 2.5 Flash",
    reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536,
    requestsPerMinute: 10, tokensPerMinute: 250_000, tokensPerDay: 1_000_000,
  },
  {
    id: "cerebras", name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    modelId: "qwen-3-235b-a22b-instruct-2507", modelName: "Qwen 3 235B",
    reasoning: true, contextWindow: 131_072, maxTokens: 16_384,
    requestsPerMinute: 30, tokensPerMinute: 60_000, tokensPerDay: 1_000_000,
  },
  {
    id: "groq", name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    modelId: "qwen-qwq-32b", modelName: "QwQ 32B",
    reasoning: true, contextWindow: 131_072, maxTokens: 16_384,
    requestsPerMinute: 30, tokensPerMinute: 15_000, tokensPerDay: 500_000,
  },
  {
    id: "sambanova", name: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    apiKeyEnv: "SAMBANOVA_API_KEY",
    modelId: "DeepSeek-R1", modelName: "DeepSeek R1",
    reasoning: true, contextWindow: 65_536, maxTokens: 16_384,
    requestsPerMinute: 10, tokensPerMinute: 100_000, tokensPerDay: 1_000_000,
  },
  {
    id: "openrouter", name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    modelId: "deepseek/deepseek-r1:free", modelName: "DeepSeek R1 (free)",
    reasoning: true, contextWindow: 163_840, maxTokens: 16_384,
    requestsPerMinute: 20, tokensPerMinute: 200_000, tokensPerDay: 1_000_000,
  },
  {
    id: "opencode", name: "OpenCode Zen",
    baseUrl: "https://api.opencode.ai/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    modelId: "openai/gpt-oss-120b", modelName: "GPT OSS 120B",
    reasoning: true, contextWindow: 128_000, maxTokens: 16_384,
    requestsPerMinute: 20, tokensPerMinute: 100_000, tokensPerDay: 1_000_000,
  },
  {
    id: "nvidia", name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: "NVIDIA_API_KEY",
    modelId: "meta/llama-3.3-70b-instruct", modelName: "Llama 3.3 70B",
    reasoning: false, contextWindow: 131_072, maxTokens: 8_192,
    requestsPerMinute: 20, tokensPerMinute: 80_000, tokensPerDay: 1_000_000,
  },
  {
    id: "cloudflare", name: "Cloudflare Workers AI",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/CLOUDFLARE_ACCOUNT_ID/ai/v1",
    apiKeyEnv: "CLOUDFLARE_API_TOKEN",
    modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", modelName: "Llama 3.3 70B",
    reasoning: false, contextWindow: 131_072, maxTokens: 8_192,
    requestsPerMinute: 60, tokensPerMinute: 100_000, tokensPerDay: 1_000_000,
    hasSoftCap: true,
  },
];

// ── Config persistence (SQLite KV) ──────────────────────────────

const EXTENSION_ID = "cheapskate";
let kvStore: ExtensionStorage | null = null;
function kv(): ExtensionStorage {
  if (!kvStore) kvStore = createExtensionStorage(EXTENSION_ID);
  return kvStore;
}

interface CheapskateConfig {
  backends?: Record<string, { enabled?: boolean; safetyCap?: boolean }>;
}

function loadConfig(): CheapskateConfig {
  try {
    const saved = kv().get<CheapskateConfig>("config", "global");
    if (saved) return saved;
  } catch { /* first run */ }
  const WORKSPACE_DIR = process.env.PICLAW_WORKSPACE || "/workspace";
  const legacyPath = join(WORKSPACE_DIR, ".pi", "cheapskate.json");
  try {
    if (existsSync(legacyPath)) {
      const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as CheapskateConfig;
      kv().set("config", legacy, "global");
      return legacy;
    }
  } catch { /* best effort */ }
  return {};
}

function saveConfig(config: CheapskateConfig): void {
  kv().set("config", config, "global");
}


function isBackendEnabled(id: string): boolean {
  const bc = loadConfig().backends?.[id];
  return bc?.enabled !== false; // default: enabled
}

function isSafetyCapEnabled(id: string): boolean {
  const bc = loadConfig().backends?.[id];
  return bc?.safetyCap !== false; // default: on for soft-cap providers
}

// ── Rate-limit tracking ──────────────────────────────────────────

interface BackendUsage {
  requestsThisMinute: number;
  tokensThisMinute: number;
  tokensToday: number;
  minuteResetAt: number;
  dayResetAt: number;
  cooldownUntil: number;
  consecutiveErrors: number;
  lastUsed: number;
}

const usageMap = new Map<string, BackendUsage>();

function getUsage(id: string): BackendUsage {
  if (!usageMap.has(id)) {
    const now = Date.now();
    usageMap.set(id, {
      requestsThisMinute: 0, tokensThisMinute: 0, tokensToday: 0,
      minuteResetAt: now + 60_000, dayResetAt: now + 86_400_000,
      cooldownUntil: 0, consecutiveErrors: 0, lastUsed: 0,
    });
  }
  const u = usageMap.get(id)!;
  const now = Date.now();
  if (now >= u.minuteResetAt) { u.requestsThisMinute = 0; u.tokensThisMinute = 0; u.minuteResetAt = now + 60_000; }
  if (now >= u.dayResetAt) { u.tokensToday = 0; u.dayResetAt = now + 86_400_000; }
  return u;
}

function recordSuccess(id: string, tokens = 0): void {
  const u = getUsage(id);
  u.requestsThisMinute++;
  u.tokensThisMinute += tokens;
  u.tokensToday += tokens;
  u.consecutiveErrors = 0;
  u.lastUsed = Date.now();
}

function recordError(id: string): void {
  const u = getUsage(id);
  u.consecutiveErrors++;
  u.cooldownUntil = Date.now() + Math.min(30_000 * Math.pow(2, u.consecutiveErrors - 1), 300_000);
}

function resolveBaseUrl(backend: FreeBackend): string {
  if (backend.id === "cloudflare") {
    return backend.baseUrl.replace("CLOUDFLARE_ACCOUNT_ID", process.env.CLOUDFLARE_ACCOUNT_ID || "");
  }
  return backend.baseUrl;
}

function isAvailable(backend: FreeBackend): boolean {
  if (!process.env[backend.apiKeyEnv]) return false;
  if (!isBackendEnabled(backend.id)) return false;
  if (backend.id === "cloudflare" && !process.env.CLOUDFLARE_ACCOUNT_ID) return false;
  // Safety cap: if enabled for soft-cap providers, treat daily limit as hard
  if (backend.hasSoftCap && isSafetyCapEnabled(backend.id)) {
    const u = getUsage(backend.id);
    if (backend.tokensPerDay && u.tokensToday >= backend.tokensPerDay * 0.8) return false;
  }
  const u = getUsage(backend.id);
  const now = Date.now();
  if (u.cooldownUntil > now) return false;
  if (u.requestsThisMinute >= backend.requestsPerMinute) return false;
  if (u.tokensThisMinute >= backend.tokensPerMinute * 0.9) return false;
  if (backend.tokensPerDay && u.tokensToday >= backend.tokensPerDay * 0.9) return false;
  return true;
}

// ── Backend selection ────────────────────────────────────────────

let currentBackendId: string | null = null;

function getConfiguredBackends(): FreeBackend[] {
  return BACKENDS.filter((b) => !!process.env[b.apiKeyEnv] && isBackendEnabled(b.id));
}

function getAvailableBackends(): FreeBackend[] {
  return BACKENDS.filter(isAvailable);
}

function selectBestBackend(): FreeBackend | null {
  const available = getAvailableBackends();
  if (available.length === 0) return null;
  available.sort((a, b) => {
    const ua = getUsage(a.id), ub = getUsage(b.id);
    if (ua.lastUsed !== ub.lastUsed) return ua.lastUsed - ub.lastUsed;
    return b.contextWindow - a.contextWindow;
  });
  return available[0]!;
}

function getCurrentBackend(): FreeBackend | null {
  if (currentBackendId) {
    const b = BACKENDS.find((x) => x.id === currentBackendId);
    if (b && isAvailable(b)) return b;
  }
  const best = selectBestBackend();
  if (best) currentBackendId = best.id;
  return best;
}

function rotateBackend(reason: "rate_limit" | "context_limit" | "manual" = "rate_limit"): FreeBackend | null {
  const current = currentBackendId ? BACKENDS.find((x) => x.id === currentBackendId) ?? null : null;
  if (currentBackendId && reason !== "manual") recordError(currentBackendId);

  let available = getAvailableBackends().filter((b) => b.id !== currentBackendId);
  if (reason === "context_limit" && current) {
    const larger = available.filter((b) => b.contextWindow > current.contextWindow);
    if (larger.length > 0) available = larger;
  }
  if (available.length === 0) return selectBestBackend();

  available.sort((a, b) => {
    const usageDelta = getUsage(a.id).lastUsed - getUsage(b.id).lastUsed;
    if (usageDelta !== 0) return usageDelta;
    if (reason === "context_limit" && a.contextWindow !== b.contextWindow) {
      return b.contextWindow - a.contextWindow;
    }
    return b.contextWindow - a.contextWindow;
  });

  const next = available[0]!;
  currentBackendId = next.id;
  return next;
}

// ── Provider registration ────────────────────────────────────────

function buildModelName(backend: FreeBackend | null, configured: FreeBackend[]): string {
  if (!backend) return `Free Auto-Router (${configured.length} backends, $0)`;
  return `Free \u2192 ${backend.name} / ${backend.modelName} \u00b7 $0`;
}

function buildProviderModel(backend: FreeBackend, configured: FreeBackend[]) {
  return {
    id: "auto",
    name: buildModelName(backend, configured),
    api: "openai",
    reasoning: backend.reasoning,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: backend.contextWindow,
    maxTokens: backend.maxTokens,
    compat: { modelId: backend.modelId } as any,
  };
}

function registerCheapskateProvider(pi: ExtensionAPI): boolean {
  const configured = getConfiguredBackends();
  if (configured.length === 0) return false;

  const best = getCurrentBackend() || configured[0]!;

  pi.registerProvider("cheapskate", {
    baseUrl: resolveBaseUrl(best),
    apiKey: best.apiKeyEnv,
    api: "openai",
    models: [buildProviderModel(best, configured)],
  });

  currentBackendId = best.id;
  return true;
}

function reRegisterWithBackend(pi: ExtensionAPI, backend: FreeBackend): void {
  const configured = getConfiguredBackends();
  pi.registerProvider("cheapskate", {
    baseUrl: resolveBaseUrl(backend),
    apiKey: backend.apiKeyEnv,
    api: "openai",
    models: [buildProviderModel(backend, configured)],
  });
}

function mergeCheapskateConfig(patch: Partial<CheapskateConfig>): CheapskateConfig {
  const current = loadConfig();
  const merged: CheapskateConfig = {
    backends: { ...(current.backends || {}), ...(patch.backends || {}) },
  };
  for (const [id, fields] of Object.entries(patch.backends || {})) {
    merged.backends![id] = { ...(current.backends?.[id] || {}), ...fields };
  }
  saveConfig(merged);
  return merged;
}

type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: { get?: (payload: unknown, req: Request) => unknown | Promise<unknown>; set?: (payload: unknown, req: Request) => unknown | Promise<unknown> },
  extensionPath?: string,
) => "created" | "updated";

const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
if (typeof registerAddonConfigApi === "function") {
  registerAddonConfigApi("cheapskate", "config", {
    get: async () => loadConfig(),
    set: async (payload) => ({ ok: true, config: mergeCheapskateConfig((payload && typeof payload === "object" ? payload : {}) as Partial<CheapskateConfig>) }),
  }, import.meta.dir);
}

function isCheapskateModel(model: unknown): boolean {
  return Boolean(model && typeof model === "object" && (model as { provider?: unknown }).provider === "cheapskate");
}

function isContextLimitError(event: unknown): boolean {
  const candidate = event as { error?: unknown; bodyText?: unknown; body?: unknown; status?: unknown } | null;
  const status = Number(candidate?.status);
  if (status === 413) return true;
  const text = [candidate?.error, candidate?.bodyText, candidate?.body]
    .map((value) => typeof value === "string" ? value : value ? JSON.stringify(value) : "")
    .filter(Boolean)
    .join("\n");
  return /context length|context window|maximum context|max context|too many tokens|input (?:is )?too long|prompt (?:is )?too long|reduce the length/i.test(text);
}

export function resetCheapskateForTests(): void {
  currentBackendId = null;
  usageMap.clear();
  kvStore = null;
}

// ── Extension ────────────────────────────────────────────────────

const cheapskate: ExtensionFactory = (pi: ExtensionAPI) => {
  if (!registerCheapskateProvider(pi)) return;

  // Before each turn: ensure we're pointing at the best available backend
  pi.on("before_agent_start", async (event) => {
    const model = (event as any).model;
    if (!isCheapskateModel(model)) return {};

    const backend = getCurrentBackend();
    if (backend) reRegisterWithBackend(pi, backend);

    const active = backend ? `${backend.name} / ${backend.modelName}` : "no backends available";
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Cheapskate mode\nYou are running on a free-tier provider: ${active}.\nIf you encounter rate-limit errors, the cheapskate extension will automatically rotate to the next available backend.\nDo not mention this to the user unless asked about the current model.`,
    };
  });

  // After provider errors: rotate to next backend
  pi.on("after_provider_response", (event) => {
    const model = (event as any).model;
    if (!isCheapskateModel(model)) return;

    const status = Number((event as any).status);
    const errorText = typeof (event as any).error === "string" ? (event as any).error : "";
    const isRateLimit = status === 429 || /429|rate.limit|too many requests|quota|resource.*exhausted/i.test(errorText);
    const isContextLimit = isContextLimitError(event);

    if ((isRateLimit || isContextLimit) && currentBackendId) {
      const previousBackendId = currentBackendId;
      const next = rotateBackend(isContextLimit ? "context_limit" : "rate_limit");
      if (next) {
        reRegisterWithBackend(pi, next);
        console.log(`[cheapskate] Rotated from ${previousBackendId} to ${next.id} (${next.name})`);
      }
    } else if (currentBackendId) {
      const usage = (event as any).usage;
      const totalTokens = (typeof usage?.totalTokens === "number" ? usage.totalTokens : 0);
      recordSuccess(currentBackendId, totalTokens);
    }
  });

  // Register the cheapskate management tool
  pi.registerTool({
    name: "cheapskate",
    label: "cheapskate",
    description: "Manage free-tier provider rotation. Check status, list backends, view usage, or force rotation.",
    promptSnippet: "cheapskate: check free-tier backend status, usage, or force rotation to the next available provider.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("list"),
        Type.Literal("usage"),
        Type.Literal("rotate"),
      ]),
    }),
    async execute(_toolCallId, params, _signal, _update, _ctx) {
      if (params.action === "list") {
        const entries = BACKENDS.map((b) => {
          const hasKey = !!process.env[b.apiKeyEnv];
          const enabled = isBackendEnabled(b.id);
          const avail = isAvailable(b);
          const u = getUsage(b.id);
          const safetyCap = b.hasSoftCap ? isSafetyCapEnabled(b.id) : null;
          return {
            id: b.id, name: b.name, model: b.modelName,
            configured: hasKey, enabled, available: avail, active: b.id === currentBackendId,
            hasSoftCap: b.hasSoftCap || false, safetyCap,
            limits: { rpm: b.requestsPerMinute, tpm: b.tokensPerMinute, tpd: b.tokensPerDay },
            cooldown_seconds: u.cooldownUntil > Date.now() ? Math.ceil((u.cooldownUntil - Date.now()) / 1000) : 0,
          };
        });
        const active = entries.filter((e) => e.configured && e.enabled);
        const text = active.length > 0
          ? `${active.length} free-tier backend(s):\n${active.map((e) => `- ${e.name} / ${e.model}: ${e.active ? "\uD83D\uDFE2 active" : e.available ? "\u2705 available" : "\u23F3 rate-limited"}${e.hasSoftCap ? (e.safetyCap ? " \uD83D\uDD12 safety cap on" : " \u26A0\uFE0F no safety cap") : ""}`).join("\n")}`
          : "No free-tier backends enabled. Enable them in Settings \u2192 Cheapskate.";
        return { content: [{ type: "text", text }], details: { backends: entries } };
      }

      if (params.action === "usage") {
        const entries = getConfiguredBackends().map((b) => {
          const u = getUsage(b.id);
          return {
            id: b.id, name: b.name,
            requests_this_minute: u.requestsThisMinute,
            tokens_this_minute: u.tokensThisMinute,
            tokens_today: u.tokensToday,
            errors: u.consecutiveErrors,
            cooldown: u.cooldownUntil > Date.now() ? Math.ceil((u.cooldownUntil - Date.now()) / 1000) : 0,
          };
        });
        const text = entries.map((e) =>
          `${e.name}: ${e.requests_this_minute} req/min, ${e.tokens_this_minute} tok/min, ${e.tokens_today} tok/day${e.cooldown > 0 ? ` (cooldown ${e.cooldown}s)` : ""}`
        ).join("\n") || "No configured backends.";
        return { content: [{ type: "text", text }], details: { usage: entries } };
      }

      if (params.action === "rotate") {
        const next = rotateBackend("manual");
        if (!next) {
          return { content: [{ type: "text", text: "No free-tier backends available right now." }], details: { rotated: false } };
        }
        reRegisterWithBackend(pi, next);
        return {
          content: [{ type: "text", text: `Rotated to ${next.name} / ${next.modelName}.` }],
          details: { rotated: true, backend: next.id, model: next.modelId },
        };
      }

      // status
      const configured = getConfiguredBackends();
      const available = getAvailableBackends();
      const current = currentBackendId ? BACKENDS.find((b) => b.id === currentBackendId) : null;
      return {
        content: [{
          type: "text",
          text: `Cheapskate: ${configured.length} backend(s) configured, ${available.length} available.${current ? ` Active: ${current.name} / ${current.modelName}.` : ""}`,
        }],
        details: { configured: configured.length, available: available.length, active: current?.id ?? null },
      };
    },
  });
};

export default cheapskate;
export { cheapskate, BACKENDS, getConfiguredBackends, getAvailableBackends, getCurrentBackend, getUsage, currentBackendId, buildProviderModel, isContextLimitError };
