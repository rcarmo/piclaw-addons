import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import cheapskate, { resetCheapskateForTests } from "./index.ts";
import { includesQuery, stateLabel } from "./web/index.ts";
import {
  classifyCatalogueCost,
  estimateRequestTokens,
  modelSupportsRequest,
  requestRequirements,
  resolveEligibleModels,
} from "./catalogue.ts";
import { applyCheapskateConfigPatch, defaultCheapskateConfig, normalizeCheapskateConfig, saveCheapskateConfig } from "./config.ts";
import { getCandidateHealth, parseRetryAfterMs, recordCandidateFailure, resetCandidateHealth, resetCheapskateHealthForTests, responseFromErrorMessage } from "./health.ts";
import { createCheapskateStream, resetCheapskateRouterForTests } from "./router.ts";
import { buildCheapskateStatus } from "./status.ts";
import type { CanonicalModelRef, RuntimeModelRegistry, ScopedModelLike } from "./shared.ts";

const savedInterop = (globalThis as any).__piclawRuntimeInterop;
const savedRegistrar = (globalThis as any).__piclaw_registerAddonConfigApi;

beforeEach(() => {
  resetCheapskateForTests();
  resetCheapskateHealthForTests();
  resetCheapskateRouterForTests();
});

afterEach(() => {
  if (savedInterop === undefined) delete (globalThis as any).__piclawRuntimeInterop;
  else (globalThis as any).__piclawRuntimeInterop = savedInterop;
  if (savedRegistrar === undefined) delete (globalThis as any).__piclaw_registerAddonConfigApi;
  else (globalThis as any).__piclaw_registerAddonConfigApi = savedRegistrar;
});

function model(overrides: Partial<Model<any>> & Pick<Model<any>, "provider" | "id">): Model<any> {
  return {
    name: overrides.id,
    api: "openai-completions",
    baseUrl: `https://${overrides.provider}.test/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  };
}

function messageFor(requestModel: Model<any>, options: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: requestModel.api,
    provider: requestModel.provider,
    model: requestModel.id,
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...options,
  };
}

type StreamPlan = (requestModel: Model<any>, options?: SimpleStreamOptions) => AssistantMessageEvent[] | Promise<AssistantMessageEvent[]>;

function createRegistry(models: Model<any>[], plans: Record<string, StreamPlan> = {}, configured = new Set(models.map((entry) => entry.provider))): RuntimeModelRegistry {
  const providers = new Map<string, any>();
  for (const entry of models) {
    if (providers.has(entry.provider)) continue;
    providers.set(entry.provider, {
      id: entry.provider,
      name: `${entry.provider} provider`,
      streamSimple(requestModel: Model<any>, _context: Context, options?: SimpleStreamOptions) {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(async () => {
          const events = await (plans[`${requestModel.provider}/${requestModel.id}`]?.(requestModel, options) || [
            { type: "start", partial: { ...messageFor(requestModel), content: [], stopReason: "pending" } },
            { type: "done", reason: "stop", message: messageFor(requestModel) },
          ]);
          for (const event of events) stream.push(event);
          const terminal = events.findLast((event) => event.type === "done" || event.type === "error");
          if (terminal?.type === "done") stream.end(terminal.message);
          else if (terminal?.type === "error") stream.end(terminal.error);
          else stream.end(messageFor(requestModel));
        });
        return stream;
      },
    });
  }
  return {
    getAll: () => models,
    getAvailable: () => models.filter((entry) => configured.has(entry.provider)),
    find: (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id),
    hasConfiguredAuth: (entry) => configured.has(entry.provider),
    getProvider: (provider) => providers.get(provider),
    getProviderDisplayName: (provider) => `${provider} provider`,
    getApiKeyAndHeaders: async (entry) => configured.has(entry.provider) ? { ok: true as const, apiKey: "test-key" } : { ok: false as const, error: "not configured" },
    registerProvider() {},
    unregisterProvider() {},
  };
}

function enabledConfig(refs: CanonicalModelRef[]) {
  const config = defaultCheapskateConfig();
  for (const ref of refs) config.models[ref] = { enabled: true };
  config.priority = [...refs];
  return config;
}

async function collect(stream: ReturnType<typeof createCheapskateStream>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("catalogue zero-cost eligibility", () => {
  test("requires finite exact-zero base rates and all-zero valid tiers", () => {
    expect(classifyCatalogueCost(model({ provider: "free", id: "base" }))).toBe("zero");
    expect(classifyCatalogueCost(model({ provider: "paid", id: "paid", cost: { input: 0, output: 0.01, cacheRead: 0, cacheWrite: 0 } }))).toBe("positive");
    expect(classifyCatalogueCost(model({ provider: "unknown", id: "missing", cost: { input: 0, output: 0, cacheRead: 0 } as any }))).toBe("unknown_or_malformed");
    expect(classifyCatalogueCost(model({ provider: "tiered", id: "paid-tier", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 1000, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }] } }))).toBe("positive");
    expect(classifyCatalogueCost(model({ provider: "tiered", id: "free-tier", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 1000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }] } }))).toBe("zero");
  });

  test("excludes recursion, unauthenticated, disabled, unscoped and incompatible models", () => {
    const free = model({ provider: "free", id: "text" });
    const image = model({ provider: "vision", id: "image", input: ["text", "image"] });
    const paid = model({ provider: "paid", id: "paid", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const recursive = model({ provider: "cheapskate", id: "auto" });
    const registry = createRegistry([free, image, paid, recursive]);
    const config = enabledConfig(["free/text", "vision/image"]);
    const requirements = { inputTokens: 100, requiresImage: true, outputTokens: 100 };
    expect(resolveEligibleModels({ registry, hasKnownCost: () => true, config, requirements }).map((entry) => entry.id)).toEqual(["image"]);
    expect(resolveEligibleModels({ registry, hasKnownCost: () => true, config, scopedModels: [{ model: free }], requirements: { ...requirements, requiresImage: false } }).map((entry) => entry.id)).toEqual(["text"]);
    config.providers.free = { enabled: false };
    expect(resolveEligibleModels({ registry, hasKnownCost: () => true, config, scopedModels: [{ model: free }] })).toEqual([]);
  });

  test("estimates context conservatively and filters image/context/output capabilities", () => {
    const context: Context = { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image", mimeType: "image/png", data: "abc" }], timestamp: 1 }] };
    const requirements = requestRequirements(context, 2_000);
    expect(estimateRequestTokens(context)).toBeGreaterThan(1_000);
    expect(requirements.requiresImage).toBe(true);
    expect(modelSupportsRequest(model({ provider: "ok", id: "ok", input: ["text", "image"], contextWindow: 10_000, maxTokens: 2_000 }), requirements)).toBe(true);
    expect(modelSupportsRequest(model({ provider: "text", id: "text", contextWindow: 10_000, maxTokens: 2_000 }), requirements)).toBe(false);
    expect(modelSupportsRequest(model({ provider: "small", id: "small", input: ["text", "image"], contextWindow: 1_000, maxTokens: 2_000 }), requirements)).toBe(false);
  });
});

describe("configuration and status", () => {
  test("migrates provider enablement but not stale models or safety caps", () => {
    expect(normalizeCheapskateConfig({ backends: { groq: { enabled: false, safetyCap: false } }, models: { "old/model": { enabled: true } } })).toEqual({
      version: 2,
      enabled: true,
      providers: { groq: { enabled: false } },
      models: { "old/model": { enabled: true } },
      priority: [],
    });
  });

  test("rejects unknown or positive-cost model references", () => {
    const current = defaultCheapskateConfig();
    expect(() => applyCheapskateConfigPatch(current, { models: { "paid/model": { enabled: true } } }, new Set(["free"]), new Set(["free/model"]))).toThrow("Unknown zero-cost model");
    expect(() => applyCheapskateConfigPatch(current, { priority: ["free/model", "free/model"] }, new Set(["free"]), new Set(["free/model"]))).toThrow("unique canonical");
  });

  test("settings status exposes only zero-cost models and derives metadata from the catalogue", () => {
    const free = model({ provider: "free", id: "vision", name: "Free Vision", input: ["text", "image"], contextWindow: 262_144, maxTokens: 32_768, reasoning: true });
    const paid = model({ provider: "paid", id: "paid", cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } });
    const config = enabledConfig(["free/vision"]);
    const status = buildCheapskateStatus(createRegistry([free, paid]), config, [], null, () => true);
    expect(status.candidates).toHaveLength(1);
    expect(status.candidates[0]).toMatchObject({ ref: "free/vision", context_window: 262_144, max_tokens: 32_768, reasoning: true, inputs: ["text", "image"], state: "eligible" });
    expect(status.excluded_costs.positive).toBe(1);
    expect(status.virtual_model_registered).toBe(true);
  });

  test("fails closed when a normalised zero cost has no declared provenance", () => {
    const unknown = model({ provider: "custom", id: "omitted-cost" });
    const config = enabledConfig(["custom/omitted-cost"]);
    const status = buildCheapskateStatus(createRegistry([unknown]), config, [], null, () => false);
    expect(status.candidates).toEqual([]);
    expect(status.excluded_costs.unknown_or_malformed).toBe(1);
    expect(status.virtual_model_registered).toBe(false);
  });
});

describe("request-local routing", () => {
  test("retries a 429 before output, preserves virtual identity and records physical responseModel", async () => {
    const first = model({ provider: "first", id: "zero" });
    const second = model({ provider: "second", id: "zero" });
    let firstCalls = 0;
    let secondCalls = 0;
    const registry = createRegistry([first, second], {
      "first/zero": (requestModel, options) => {
        firstCalls++;
        void options?.onResponse?.({ status: 429, headers: { "retry-after": "2" } }, requestModel);
        return [{ type: "error", reason: "error", error: messageFor(requestModel, { content: [], stopReason: "error", errorMessage: "rate limited" }) }];
      },
      "second/zero": (requestModel) => {
        secondCalls++;
        return [{ type: "start", partial: messageFor(requestModel, { content: [], stopReason: "pending" }) }, { type: "done", reason: "stop", message: messageFor(requestModel) }];
      },
    });
    const config = enabledConfig(["first/zero", "second/zero"]);
    saveCheapskateConfig(config);
    (globalThis as any).__piclawRuntimeInterop = { getModelRegistry: () => registry };
    const virtual = model({ provider: "cheapskate", id: "auto" });
    let dispatchedOptions: SimpleStreamOptions | undefined;
    const events = await collect(createCheapskateStream(virtual, { messages: [] }, { sessionId: "s1", apiKey: "virtual-key", headers: { "x-virtual": "remove" }, env: { VIRTUAL: "remove" } }, {
      registry,
      hasKnownCost: () => true,
      scopedModels: () => [],
      streamSimple: (requestModel, context, options) => {
        dispatchedOptions = options;
        return registry.getProvider(requestModel.provider)!.streamSimple(requestModel, context, options);
      },
    }));
    const done = events.findLast((event) => event.type === "done");
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect(dispatchedOptions?.apiKey).toBeUndefined();
    expect(dispatchedOptions?.headers).toBeUndefined();
    expect(dispatchedOptions?.env).toBeUndefined();
    expect(dispatchedOptions?.sessionId).toBe("s1");
    expect(typeof dispatchedOptions?.fetch).toBe("function");
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(done.message).toMatchObject({ provider: "cheapskate", model: "auto", responseModel: "second/zero" });
    expect(getCandidateHealth("first/zero").state).toBe("cooldown");
  });

  test("never replays after text output has started", async () => {
    const first = model({ provider: "first", id: "zero" });
    const second = model({ provider: "second", id: "zero" });
    let secondCalls = 0;
    const registry = createRegistry([first, second], {
      "first/zero": (requestModel) => {
        const partial = messageFor(requestModel, { content: [{ type: "text", text: "partial" }], stopReason: "pending" });
        return [
          { type: "start", partial: { ...partial, content: [] } },
          { type: "text_start", contentIndex: 0, partial },
          { type: "text_delta", contentIndex: 0, delta: "partial", partial },
          { type: "error", reason: "error", error: messageFor(requestModel, { content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "temporary network failure" }) },
        ];
      },
      "second/zero": (requestModel) => { secondCalls++; return [{ type: "done", reason: "stop", message: messageFor(requestModel) }]; },
    });
    const config = enabledConfig(["first/zero", "second/zero"]);
    saveCheapskateConfig(config);
    (globalThis as any).__piclawRuntimeInterop = { getModelRegistry: () => registry };
    const events = await collect(createCheapskateStream(model({ provider: "cheapskate", id: "auto" }), { messages: [] }, undefined, { registry, hasKnownCost: () => true, scopedModels: () => [], streamSimple: (requestModel, context, options) => registry.getProvider(requestModel.provider)!.streamSimple(requestModel, context, options) }));
    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
    expect(secondCalls).toBe(0);
  });

  test("uses request-local scope without cross-session candidate leakage", async () => {
    const alpha = model({ provider: "alpha", id: "zero" });
    const beta = model({ provider: "beta", id: "zero" });
    const registry = createRegistry([alpha, beta]);
    const config = enabledConfig(["alpha/zero", "beta/zero"]);
    saveCheapskateConfig(config);
    (globalThis as any).__piclawRuntimeInterop = { getModelRegistry: () => registry };
    const virtual = model({ provider: "cheapskate", id: "auto" });
    const run = async (sessionId: string, scopedModels: ScopedModelLike[]) => {
      const events = await collect(createCheapskateStream(virtual, { messages: [] }, { sessionId }, { registry, hasKnownCost: () => true, scopedModels: () => scopedModels, streamSimple: (requestModel, context, options) => registry.getProvider(requestModel.provider)!.streamSimple(requestModel, context, options) }));
      const done = events.findLast((event) => event.type === "done");
      return done?.type === "done" ? done.message.responseModel : null;
    };
    expect(await Promise.all([run("alpha-session", [{ model: alpha }]), run("beta-session", [{ model: beta }])])).toEqual(["alpha/zero", "beta/zero"]);
  });

  test("parses provider reset headers with bounded cooldowns", () => {
    expect(parseRetryAfterMs({ status: 429, headers: { "retry-after": "12" } }, 1_000)).toBe(12_000);
    expect(parseRetryAfterMs({ status: 429, headers: { "retry-after": "9999" } }, 1_000)).toBe(300_000);
  });

  test("captures non-2xx response headers through the physical fetch path", async () => {
    const limited = model({ provider: "limited", id: "zero" });
    const fallback = model({ provider: "fallback", id: "zero" });
    let capturedFetch: typeof fetch | undefined;
    const registry = createRegistry([limited, fallback], {
      "limited/zero": async (requestModel, options) => {
        capturedFetch = options?.fetch;
        await capturedFetch?.(new Request("https://limited.test"));
        return [{ type: "error", reason: "error", error: messageFor(requestModel, { content: [], stopReason: "error", errorMessage: "429 rate limited" }) }];
      },
      "fallback/zero": (requestModel) => [{ type: "done", reason: "stop", message: messageFor(requestModel) }],
    });
    saveCheapskateConfig(enabledConfig(["limited/zero", "fallback/zero"]));
    const limitedFetch = async () => new Response("limited", { status: 429, headers: { "retry-after": "9" } });
    await collect(createCheapskateStream(model({ provider: "cheapskate", id: "auto" }), { messages: [] }, {
      fetch: limitedFetch as unknown as typeof fetch,
    }, {
      registry,
      hasKnownCost: () => true,
      scopedModels: () => [],
      streamSimple: (requestModel, context, options) => registry.getProvider(requestModel.provider)!.streamSimple(requestModel, context, options),
    }));
    expect(typeof capturedFetch).toBe("function");
    const health = getCandidateHealth("limited/zero");
    expect(health.state).toBe("cooldown");
    expect(health.cooldownUntil - Date.now()).toBeGreaterThan(8_000);
  });

  test("does not quarantine a model globally for request-specific context overflow", () => {
    recordCandidateFailure("free/large-prompt", "context", "context window exceeded", { status: 413, headers: {} }, 1_000);
    expect(getCandidateHealth("free/large-prompt", 1_000)).toMatchObject({ state: "healthy", cooldownUntil: 0, lastError: "context window exceeded" });
  });

  test("keeps permanent faults quarantined until an explicit model setting change", () => {
    recordCandidateFailure("free/recovered", "credential", "invalid key", { status: 401, headers: {} });
    expect(getCandidateHealth("free/recovered").state).toBe("credential_fault");
    recordCandidateFailure("free/missing", "missing_model", "not found", { status: 404, headers: {} });
    expect(getCandidateHealth("free/missing").state).toBe("missing_model");
  });

  test("extracts HTTP status from mapped provider errors when onResponse did not fire", () => {
    expect(responseFromErrorMessage(messageFor(model({ provider: "free", id: "zero" }), { stopReason: "error", errorMessage: '429: {"message":"limited"}' }))).toEqual({ status: 429, headers: {} });
  });

  test("allows an explicit model setting change to reset a permanent health quarantine", () => {
    recordCandidateFailure("free/reset", "credential", "invalid key", { status: 401, headers: {} });
    expect(getCandidateHealth("free/reset").state).toBe("credential_fault");
    resetCandidateHealth("free/reset");
    expect(getCandidateHealth("free/reset").state).toBe("healthy");
  });
});

describe("settings filtering", () => {
  test("filters the already zero-cost candidate DTOs by text and provider", () => {
    const candidate = buildCheapskateStatus(createRegistry([model({ provider: "free", id: "vision", name: "Zero Vision", input: ["text", "image"] })]), enabledConfig(["free/vision"]), [], null, () => true).candidates[0]!;
    expect(includesQuery(candidate, "vision", "free")).toBe(true);
    expect(includesQuery(candidate, "missing", "free")).toBe(false);
    expect(includesQuery(candidate, "vision", "other")).toBe(false);
    expect(stateLabel(candidate)).toBe("Eligible now");
  });
});

describe("extension integration contract", () => {
  test("uses real current lifecycle fields and no hardcoded backend catalogue", () => {
    const source = readFileSync(resolve(import.meta.dir, "index.ts"), "utf8");
    const web = readFileSync(resolve(import.meta.dir, "web", "index.ts"), "utf8");
    const readme = readFileSync(resolve(import.meta.dir, "README.md"), "utf8");
    const skill = readFileSync(resolve(import.meta.dir, "skills", "cheapskate", "SKILL.md"), "utf8");
    expect(source).not.toContain("event as any");
    expect(source).not.toContain("after_provider_response");
    expect(source).not.toContain("qwen-qwq-32b");
    expect(web).not.toContain("const BACKENDS");
    expect(web).not.toContain("@ts-nocheck");
    expect(readme).toContain("exact-zero catalogue price");
    expect(readme).toContain("normalised zero defaults do not qualify as free");
    expect(readme).toContain("responseModel");
    expect(readme).not.toContain("QwQ 32B");
    expect(skill).toContain("finite zero rates");
    expect(skill).not.toContain("TPD");
  });

  test("registers the virtual provider only when an explicitly enabled zero-cost model is available", () => {
    const free = model({ provider: "free", id: "zero" });
    const registry = createRegistry([free]);
    const registrations: string[] = [];
    const api = {
      registerProvider(name: string) { registrations.push(name); },
      unregisterProvider() {},
      on() {},
      registerTool() {},
    } as any;
    (globalThis as any).__piclawRuntimeInterop = { getModelRegistry: () => registry, getScopedModels: () => [] };
    cheapskate(api);
    expect(registrations).toEqual([]);
  });
});
