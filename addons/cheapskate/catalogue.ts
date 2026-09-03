import type { Context, Message, Model } from "@earendil-works/pi-ai";

import {
  CHEAPSKATE_PROVIDER_ID,
  canonicalModelRef,
  type CanonicalModelRef,
  type CheapskateConfig,
  type ModelCostProvenance,
  type RuntimeModelRegistry,
  type ScopedModelLike,
} from "./shared.js";

const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

export type CostEligibility = "zero" | "positive" | "unknown_or_malformed";

function zeroRates(value: unknown): CostEligibility {
  if (!value || typeof value !== "object") return "unknown_or_malformed";
  for (const field of COST_FIELDS) {
    const rate = (value as Record<string, unknown>)[field];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return "unknown_or_malformed";
    if (rate > 0) return "positive";
  }
  return "zero";
}

export function classifyCatalogueCost(model: Pick<Model<any>, "cost">): CostEligibility {
  const base = zeroRates(model.cost);
  if (base !== "zero") return base;
  const tiers = (model.cost as { tiers?: unknown }).tiers;
  if (tiers === undefined) return "zero";
  if (!Array.isArray(tiers)) return "unknown_or_malformed";
  for (const tier of tiers) {
    const rates = zeroRates(tier);
    if (rates !== "zero") return rates;
    const threshold = (tier as Record<string, unknown>).inputTokensAbove;
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) return "unknown_or_malformed";
  }
  return "zero";
}

export function isCatalogueZeroModel(model: Model<any>): boolean {
  return model.provider !== CHEAPSKATE_PROVIDER_ID && classifyCatalogueCost(model) === "zero";
}

export function scopeAllows(model: Model<any>, scopedModels: readonly ScopedModelLike[]): boolean {
  if (scopedModels.length === 0) return true;
  const ref = canonicalModelRef(model);
  return scopedModels.some((entry) => canonicalModelRef(entry.model) === ref);
}

export function isProviderEnabled(config: CheapskateConfig, provider: string): boolean {
  return config.providers[provider]?.enabled !== false;
}

export function isModelEnabled(config: CheapskateConfig, ref: CanonicalModelRef): boolean {
  return config.models[ref]?.enabled === true;
}

export function orderedZeroModels(models: readonly Model<any>[], config: CheapskateConfig): Model<any>[] {
  const priority = new Map(config.priority.map((ref, index) => [ref, index]));
  return models.filter(isCatalogueZeroModel).sort((a, b) => {
    const aRef = canonicalModelRef(a);
    const bRef = canonicalModelRef(b);
    const aPriority = priority.get(aRef);
    const bPriority = priority.get(bRef);
    if (aPriority !== undefined || bPriority !== undefined) {
      if (aPriority === undefined) return 1;
      if (bPriority === undefined) return -1;
      if (aPriority !== bPriority) return aPriority - bPriority;
    }
    return a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

function contextNeedsImage(context: Context): boolean {
  return context.messages.some((message) => {
    if (message.role === "assistant") return false;
    if (typeof message.content === "string") return false;
    return message.content.some((content) => content.type === "image");
  });
}

export interface RequestRequirements {
  inputTokens: number;
  requiresImage: boolean;
  outputTokens: number;
}

function estimateMessageTokens(message: Message): number {
  let characters = 0;
  if (message.role === "user") {
    if (typeof message.content === "string") characters += message.content.length;
    else for (const content of message.content) characters += content.type === "image" ? 4_800 : content.text.length;
  } else if (message.role === "assistant") {
    for (const content of message.content) {
      if (content.type === "text") characters += content.text.length;
      else if (content.type === "thinking") characters += content.thinking.length;
      else characters += content.name.length + JSON.stringify(content.arguments).length;
    }
  } else {
    characters += message.toolName.length;
    for (const content of message.content) characters += content.type === "image" ? 4_800 : content.text.length;
  }
  return Math.ceil(characters / 4);
}

export function estimateRequestTokens(context: Context): number {
  let tokens = context.systemPrompt ? Math.ceil(context.systemPrompt.length / 4) : 0;
  for (const message of context.messages) tokens += estimateMessageTokens(message);
  if (context.tools?.length) tokens += Math.ceil(JSON.stringify(context.tools).length / 4);
  return tokens;
}

export function requestRequirements(context: Context, requestedMaxTokens?: number): RequestRequirements {
  return {
    inputTokens: estimateRequestTokens(context),
    requiresImage: contextNeedsImage(context),
    outputTokens: Math.max(1, Math.floor(requestedMaxTokens || 1)),
  };
}

export function modelSupportsRequest(model: Model<any>, requirements: RequestRequirements): boolean {
  if (requirements.requiresImage && !model.input.includes("image")) return false;
  if (model.contextWindow <= requirements.inputTokens) return false;
  if (model.maxTokens < requirements.outputTokens) return false;
  return true;
}

export interface CandidateResolutionOptions {
  registry: RuntimeModelRegistry;
  hasKnownCost: ModelCostProvenance;
  config: CheapskateConfig;
  scopedModels?: readonly ScopedModelLike[];
  requirements?: RequestRequirements;
  excludedRefs?: ReadonlySet<CanonicalModelRef>;
  requireAvailable?: boolean;
}

export function resolveEligibleModels(options: CandidateResolutionOptions): Model<any>[] {
  if (!options.config.enabled) return [];
  const scopedModels = options.scopedModels ?? [];
  const allModels = options.registry.getAll();
  const availableRefs = new Set(options.registry.getAvailable().map(canonicalModelRef));
  return orderedZeroModels(allModels, options.config).filter((model) => {
    const ref = canonicalModelRef(model);
    const configured = options.registry.hasConfiguredAuth(model) && (options.requireAvailable === false || availableRefs.has(ref));
    if (!options.hasKnownCost(model.provider, model.id)) return false;
    if (options.excludedRefs?.has(ref)) return false;
    if (!configured) return false;
    if (!scopeAllows(model, scopedModels)) return false;
    if (!isProviderEnabled(options.config, model.provider)) return false;
    if (!isModelEnabled(options.config, ref)) return false;
    if (options.requirements && !modelSupportsRequest(model, options.requirements)) return false;
    return true;
  });
}
