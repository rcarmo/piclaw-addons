/**
 * piclaw-addon-cheapskate — Free-tier provider rotation.
 *
 * Registers multiple free-tier providers and implements automatic
 * rotation when rate limits are hit. The agent gets access to free
 * models across Google, Cerebras, Groq, SambaNova, and others.
 *
 * When one provider returns a 429 or rate-limit error, the extension
 * catches it and switches to the next available provider automatically.
 */

import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ── Free-tier provider definitions ───────────────────────────────

interface FreeTierProvider {
  name: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  api: "openai";
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    inputCost: number;
    outputCost: number;
  }>;
  dailyRequestLimit?: number;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  tokensPerDay?: number;
}

const FREE_TIER_PROVIDERS: FreeTierProvider[] = [
  {
    name: "google-free",
    displayName: "Google Gemini (free tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    api: "openai",
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, inputCost: 0, outputCost: 0 },
      { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", reasoning: false, contextWindow: 1_000_000, maxTokens: 65_536, inputCost: 0, outputCost: 0 },
    ],
    requestsPerMinute: 10,
    tokensPerMinute: 250_000,
    tokensPerDay: 1_000_000,
  },
  {
    name: "cerebras-free",
    displayName: "Cerebras (free tier)",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    api: "openai",
    models: [
      { id: "qwen-3-235b-a22b-instruct-2507", name: "Qwen 3 235B", reasoning: true, contextWindow: 131_072, maxTokens: 16_384, inputCost: 0, outputCost: 0 },
      { id: "llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout", reasoning: false, contextWindow: 131_072, maxTokens: 16_384, inputCost: 0, outputCost: 0 },
      { id: "llama3.1-8b", name: "Llama 3.1 8B", reasoning: false, contextWindow: 131_072, maxTokens: 16_384, inputCost: 0, outputCost: 0 },
    ],
    requestsPerMinute: 30,
    tokensPerMinute: 60_000,
    tokensPerDay: 1_000_000,
  },
  {
    name: "groq-free",
    displayName: "Groq (free tier)",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    api: "openai",
    models: [
      { id: "llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout (Groq)", reasoning: false, contextWindow: 131_072, maxTokens: 8_192, inputCost: 0, outputCost: 0 },
      { id: "qwen-qwq-32b", name: "QwQ 32B (Groq)", reasoning: true, contextWindow: 131_072, maxTokens: 16_384, inputCost: 0, outputCost: 0 },
      { id: "gemma2-9b-it", name: "Gemma 2 9B (Groq)", reasoning: false, contextWindow: 8_192, maxTokens: 4_096, inputCost: 0, outputCost: 0 },
    ],
    requestsPerMinute: 30,
    tokensPerMinute: 15_000,
    tokensPerDay: 500_000,
  },
  {
    name: "sambanova-free",
    displayName: "SambaNova (free tier)",
    baseUrl: "https://api.sambanova.ai/v1",
    apiKeyEnv: "SAMBANOVA_API_KEY",
    api: "openai",
    models: [
      { id: "DeepSeek-R1", name: "DeepSeek R1 (SambaNova)", reasoning: true, contextWindow: 65_536, maxTokens: 16_384, inputCost: 0, outputCost: 0 },
      { id: "QwQ-32B", name: "QwQ 32B (SambaNova)", reasoning: true, contextWindow: 65_536, maxTokens: 16_384, inputCost: 0, outputCost: 0 },
      { id: "Meta-Llama-3.3-70B-Instruct", name: "Llama 3.3 70B (SambaNova)", reasoning: false, contextWindow: 131_072, maxTokens: 16_384, inputCost: 0, outputCost: 0 },
    ],
    requestsPerMinute: 10,
    tokensPerMinute: 100_000,
  },
];

// ── Rate-limit tracking ──────────────────────────────────────────

interface ProviderUsage {
  name: string;
  requestsThisMinute: number;
  tokensThisMinute: number;
  tokensToday: number;
  minuteResetAt: number;
  dayResetAt: number;
  cooldownUntil: number;
  consecutiveErrors: number;
}

const usageMap = new Map<string, ProviderUsage>();

function getUsage(name: string): ProviderUsage {
  if (!usageMap.has(name)) {
    const now = Date.now();
    usageMap.set(name, {
      name,
      requestsThisMinute: 0,
      tokensThisMinute: 0,
      tokensToday: 0,
      minuteResetAt: now + 60_000,
      dayResetAt: now + 86_400_000,
      cooldownUntil: 0,
      consecutiveErrors: 0,
    });
  }
  const usage = usageMap.get(name)!;
  const now = Date.now();
  if (now >= usage.minuteResetAt) {
    usage.requestsThisMinute = 0;
    usage.tokensThisMinute = 0;
    usage.minuteResetAt = now + 60_000;
  }
  if (now >= usage.dayResetAt) {
    usage.tokensToday = 0;
    usage.dayResetAt = now + 86_400_000;
  }
  return usage;
}

function recordRequest(name: string, tokens: number): void {
  const usage = getUsage(name);
  usage.requestsThisMinute++;
  usage.tokensThisMinute += tokens;
  usage.tokensToday += tokens;
  usage.consecutiveErrors = 0;
}

function recordError(name: string): void {
  const usage = getUsage(name);
  usage.consecutiveErrors++;
  // Exponential backoff: 30s, 60s, 120s, 240s, max 5min
  const backoffMs = Math.min(30_000 * Math.pow(2, usage.consecutiveErrors - 1), 300_000);
  usage.cooldownUntil = Date.now() + backoffMs;
}

function isAvailable(provider: FreeTierProvider): boolean {
  if (!process.env[provider.apiKeyEnv]) return false;
  const usage = getUsage(provider.name);
  const now = Date.now();
  if (usage.cooldownUntil > now) return false;
  if (provider.requestsPerMinute && usage.requestsThisMinute >= provider.requestsPerMinute) return false;
  if (provider.tokensPerMinute && usage.tokensThisMinute >= provider.tokensPerMinute * 0.9) return false;
  if (provider.tokensPerDay && usage.tokensToday >= provider.tokensPerDay * 0.9) return false;
  return true;
}

// ── Provider rotation ────────────────────────────────────────────

let rotationIndex = 0;

function getNextAvailableProvider(): FreeTierProvider | null {
  const available = FREE_TIER_PROVIDERS.filter(isAvailable);
  if (available.length === 0) return null;
  rotationIndex = rotationIndex % available.length;
  const provider = available[rotationIndex]!;
  rotationIndex = (rotationIndex + 1) % available.length;
  return provider;
}

function getBestModel(provider: FreeTierProvider): typeof provider.models[0] | null {
  // Prefer reasoning models first, then largest context window
  const sorted = [...provider.models].sort((a, b) => {
    if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
    return b.contextWindow - a.contextWindow;
  });
  return sorted[0] ?? null;
}

// ── Extension ────────────────────────────────────────────────────

const cheapskate: ExtensionFactory = (pi: ExtensionAPI) => {
  const registeredProviders: string[] = [];

  // Register all free-tier providers that have API keys configured
  for (const provider of FREE_TIER_PROVIDERS) {
    const apiKey = process.env[provider.apiKeyEnv];
    if (!apiKey) continue;

    pi.registerProvider(provider.name, {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKeyEnv,
      api: provider.api,
      models: provider.models.map((m) => ({
        id: m.id,
        name: m.name,
        api: provider.api,
        reasoning: m.reasoning,
        input: ["text", "image"] as ("text" | "image")[],
        cost: { input: m.inputCost, output: m.outputCost, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    });
    registeredProviders.push(provider.name);
  }

  if (registeredProviders.length === 0) return;

  // Inject cheapskate hint into system prompt
  pi.on("before_agent_start", async (event) => {
    const available = FREE_TIER_PROVIDERS.filter(isAvailable);
    const hint = available.length > 0
      ? `Cheapskate mode active: ${available.length} free-tier provider(s) available (${available.map((p) => p.displayName).join(", ")}). Use switch_model to select one, or the cheapskate tool to rotate automatically.`
      : "Cheapskate mode: no free-tier providers currently available (rate limits or missing API keys).";
    return { systemPrompt: `${event.systemPrompt}\n\n${hint}` };
  });

  // Register the cheapskate management tool
  pi.registerTool({
    name: "cheapskate",
    label: "cheapskate",
    description: "Manage free-tier provider rotation. List available providers, check usage/limits, or rotate to the next free provider.",
    promptSnippet: "cheapskate: list free providers, check usage, or rotate to next available free-tier model.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("rotate"),
        Type.Literal("list"),
        Type.Literal("usage"),
      ]),
    }),
    async execute(_toolCallId, params, _signal, _update, _ctx) {
      if (params.action === "list") {
        const entries = FREE_TIER_PROVIDERS.map((p) => {
          const hasKey = !!process.env[p.apiKeyEnv];
          const available = isAvailable(p);
          const usage = getUsage(p.name);
          return {
            provider: p.name,
            display: p.displayName,
            configured: hasKey,
            available,
            models: p.models.map((m) => m.name),
            limits: {
              rpm: p.requestsPerMinute ?? null,
              tpm: p.tokensPerMinute ?? null,
              tpd: p.tokensPerDay ?? null,
            },
            cooldown: usage.cooldownUntil > Date.now() ? Math.ceil((usage.cooldownUntil - Date.now()) / 1000) : 0,
          };
        });
        const configured = entries.filter((e) => e.configured);
        const text = configured.length > 0
          ? `${configured.length} free-tier provider(s) configured:\n${configured.map((e) => `- ${e.display}: ${e.available ? "✅ available" : "⏳ rate-limited"} (${e.models.join(", ")})`).join("\n")}`
          : "No free-tier providers configured. Set API key env vars to enable.";
        return { content: [{ type: "text", text }], details: { providers: entries } };
      }

      if (params.action === "usage") {
        const entries = FREE_TIER_PROVIDERS.filter((p) => !!process.env[p.apiKeyEnv]).map((p) => {
          const usage = getUsage(p.name);
          return {
            provider: p.name,
            display: p.displayName,
            requests_this_minute: usage.requestsThisMinute,
            tokens_this_minute: usage.tokensThisMinute,
            tokens_today: usage.tokensToday,
            consecutive_errors: usage.consecutiveErrors,
            cooldown_seconds: usage.cooldownUntil > Date.now() ? Math.ceil((usage.cooldownUntil - Date.now()) / 1000) : 0,
            limits: {
              rpm: p.requestsPerMinute ?? null,
              tpm: p.tokensPerMinute ?? null,
              tpd: p.tokensPerDay ?? null,
            },
          };
        });
        const text = entries.length > 0
          ? entries.map((e) => `${e.display}: ${e.requests_this_minute} req/min, ${e.tokens_this_minute} tok/min, ${e.tokens_today} tok/day${e.cooldown_seconds > 0 ? ` (cooldown ${e.cooldown_seconds}s)` : ""}`).join("\n")
          : "No configured providers.";
        return { content: [{ type: "text", text }], details: { usage: entries } };
      }

      if (params.action === "rotate") {
        const next = getNextAvailableProvider();
        if (!next) {
          return {
            content: [{ type: "text", text: "No free-tier providers available right now. All are rate-limited or unconfigured." }],
            details: { rotated: false },
          };
        }
        const model = getBestModel(next);
        if (!model) {
          return {
            content: [{ type: "text", text: `Provider ${next.displayName} has no available models.` }],
            details: { rotated: false },
          };
        }
        const success = await pi.setModel(`${next.name}/${model.id}` as any);
        return {
          content: [{
            type: "text",
            text: success
              ? `Rotated to ${next.displayName} / ${model.name}.`
              : `Failed to switch to ${next.displayName} / ${model.name}.`,
          }],
          details: { rotated: success, provider: next.name, model: model.id },
        };
      }

      // status
      const available = FREE_TIER_PROVIDERS.filter(isAvailable);
      const configured = FREE_TIER_PROVIDERS.filter((p) => !!process.env[p.apiKeyEnv]);
      return {
        content: [{
          type: "text",
          text: `Cheapskate mode: ${configured.length} provider(s) configured, ${available.length} currently available.`,
        }],
        details: {
          configured: configured.length,
          available: available.length,
          providers: configured.map((p) => p.name),
          available_now: available.map((p) => p.name),
        },
      };
    },
  });
};

export default cheapskate;
export { cheapskate, FREE_TIER_PROVIDERS };
