/**
 * piclaw-addon-cheapskate — Free-tier provider rotation as a single selectable model.
 *
 * Registers a `cheapskate` provider with an `auto` model. When selected,
 * it transparently routes requests to the best available free-tier backend
 * (Google Gemini, Cerebras, Groq, SambaNova) and rotates on rate-limit errors.
 *
 * The user just picks `cheapskate/auto` from the model selector.
 */

import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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
];

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

function isAvailable(backend: FreeBackend): boolean {
  if (!process.env[backend.apiKeyEnv]) return false;
  const u = getUsage(backend.id);
  const now = Date.now();
  if (u.cooldownUntil > now) return false;
  if (u.requestsThisMinute >= backend.requestsPerMinute) return false;
  if (u.tokensThisMinute >= backend.tokensPerMinute * 0.9) return false;
  if (u.tokensPerDay && u.tokensToday >= backend.tokensPerDay * 0.9) return false;
  return true;
}

// ── Backend selection ────────────────────────────────────────────

let currentBackendId: string | null = null;

function getConfiguredBackends(): FreeBackend[] {
  return BACKENDS.filter((b) => !!process.env[b.apiKeyEnv]);
}

function getAvailableBackends(): FreeBackend[] {
  return BACKENDS.filter(isAvailable);
}

function selectBestBackend(): FreeBackend | null {
  const available = getAvailableBackends();
  if (available.length === 0) return null;
  // Prefer: least recently used, then largest context window
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

function rotateBackend(): FreeBackend | null {
  if (currentBackendId) recordError(currentBackendId);
  const available = getAvailableBackends().filter((b) => b.id !== currentBackendId);
  if (available.length === 0) return selectBestBackend();
  available.sort((a, b) => getUsage(a.id).lastUsed - getUsage(b.id).lastUsed);
  const next = available[0]!;
  currentBackendId = next.id;
  return next;
}

// ── Provider registration ────────────────────────────────────────

function buildModelName(backend: FreeBackend | null, configured: FreeBackend[]): string {
  if (!backend) return `Free Auto-Router (${configured.length} backends, $0)`;
  return `Free → ${backend.name} / ${backend.modelName} · $0`;
}

function registerCheapskateProvider(pi: ExtensionAPI): boolean {
  const configured = getConfiguredBackends();
  if (configured.length === 0) return false;

  const best = getCurrentBackend() || configured[0]!;
  const bestContext = Math.max(...configured.map((b) => b.contextWindow));
  const anyReasoning = configured.some((b) => b.reasoning);

  pi.registerProvider("cheapskate", {
    baseUrl: best.baseUrl,
    apiKey: best.apiKeyEnv,
    api: "openai",
    models: [{
      id: "auto",
      name: buildModelName(best, configured),
      api: "openai",
      reasoning: anyReasoning,
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: bestContext,
      maxTokens: Math.max(...configured.map((b) => b.maxTokens)),
      compat: { modelId: best.modelId },
    }],
  });

  currentBackendId = best.id;
  return true;
}

function reRegisterWithBackend(pi: ExtensionAPI, backend: FreeBackend): void {
  const configured = getConfiguredBackends();
  const bestContext = Math.max(...configured.map((b) => b.contextWindow));
  const anyReasoning = configured.some((b) => b.reasoning);

  pi.registerProvider("cheapskate", {
    baseUrl: backend.baseUrl,
    apiKey: backend.apiKeyEnv,
    api: "openai",
    models: [{
      id: "auto",
      name: buildModelName(backend, configured),
      api: "openai",
      reasoning: anyReasoning,
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: bestContext,
      maxTokens: Math.max(...configured.map((b) => b.maxTokens)),
      compat: { modelId: backend.modelId },
    }],
  });
}

// ── Extension ────────────────────────────────────────────────────

const cheapskate: ExtensionFactory = (pi: ExtensionAPI) => {
  if (!registerCheapskateProvider(pi)) return;

  // Before each turn: ensure we're pointing at the best available backend
  pi.on("before_agent_start", async (event) => {
    const model = event.model;
    const isCheapskate = model?.provider === "cheapskate" || model?.id === "auto";
    if (!isCheapskate) return {};

    const backend = getCurrentBackend();
    if (backend) {
      reRegisterWithBackend(pi, backend);
    }

    const active = backend ? `${backend.name} / ${backend.modelName}` : "no backends available";
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Cheapskate mode\nYou are running on a free-tier provider: ${active}.\nIf you encounter rate-limit errors, the cheapskate extension will automatically rotate to the next available backend.\nDo not mention this to the user unless asked about the current model.`,
    };
  });

  // After provider errors: rotate to next backend
  pi.on("after_provider_response", (event) => {
    const model = event.model;
    const isCheapskate = model?.provider === "cheapskate";
    if (!isCheapskate) return;

    // Check for rate-limit or error indicators
    const errorText = typeof (event as any).error === "string" ? (event as any).error : "";
    const isRateLimit = /429|rate.limit|too many requests|quota|resource.*exhausted/i.test(errorText);

    if (isRateLimit && currentBackendId) {
      const next = rotateBackend();
      if (next) {
        reRegisterWithBackend(pi, next);
        console.log(`[cheapskate] Rotated from ${currentBackendId} to ${next.id} (${next.name})`);
      }
    } else if (currentBackendId) {
      // Estimate tokens from response for tracking
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
          const avail = isAvailable(b);
          const u = getUsage(b.id);
          return {
            id: b.id, name: b.name, model: b.modelName,
            configured: hasKey, available: avail, active: b.id === currentBackendId,
            limits: { rpm: b.requestsPerMinute, tpm: b.tokensPerMinute, tpd: b.tokensPerDay },
            cooldown_seconds: u.cooldownUntil > Date.now() ? Math.ceil((u.cooldownUntil - Date.now()) / 1000) : 0,
          };
        });
        const configured = entries.filter((e) => e.configured);
        const text = configured.length > 0
          ? `${configured.length} free-tier backend(s):\n${configured.map((e) => `- ${e.name} / ${e.model}: ${e.active ? "🟢 active" : e.available ? "✅ available" : "⏳ rate-limited"}`).join("\n")}`
          : "No free-tier backends configured. Set API key env vars to enable.";
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
        const next = rotateBackend();
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
export { cheapskate, BACKENDS, getConfiguredBackends, getAvailableBackends, getCurrentBackend, getUsage, currentBackendId };
