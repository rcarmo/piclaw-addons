import type { Model } from "@earendil-works/pi-ai";

import {
  classifyCatalogueCost,
  isModelEnabled,
  isProviderEnabled,
  orderedZeroModels,
  resolveEligibleModels,
  scopeAllows,
} from "./catalogue.js";
import { healthAllowsSelection, healthDto } from "./health.js";
import { activeRefForSession } from "./router.js";
import {
  canonicalModelRef,
  type CanonicalModelRef,
  type CheapskateCandidateDto,
  type CheapskateConfig,
  type CheapskateStatusDto,
  type ModelCostProvenance,
  type RuntimeModelRegistry,
  type ScopedModelLike,
} from "./shared.js";

function candidateState(
  model: Model<any>,
  registry: RuntimeModelRegistry,
  availableRefs: ReadonlySet<CanonicalModelRef>,
  config: CheapskateConfig,
  scopedModels: readonly ScopedModelLike[],
): CheapskateCandidateDto["state"] {
  const ref = canonicalModelRef(model);
  if (!registry.hasConfiguredAuth(model) || !availableRefs.has(ref)) return "needs_credentials";
  if (!scopeAllows(model, scopedModels)) return "excluded_by_scope";
  if (!isProviderEnabled(config, model.provider) || !isModelEnabled(config, ref)) return "disabled";
  if (!healthAllowsSelection(ref)) return "unhealthy";
  return "eligible";
}

export function buildCheapskateStatus(
  registry: RuntimeModelRegistry | null,
  config: CheapskateConfig,
  scopedModels: readonly ScopedModelLike[] = [],
  sessionId?: string | null,
  hasKnownCost: ModelCostProvenance = () => false,
): CheapskateStatusDto {
  if (!registry) {
    return {
      ok: true,
      config,
      virtual_model_registered: false,
      active_ref: null,
      candidates: [],
      excluded_costs: { positive: 0, unknown_or_malformed: 0, recursive: 0 },
      empty_reason: "The Piclaw model catalogue is not available in this runtime.",
    };
  }

  const all = registry.getAll();
  const activeRef = activeRefForSession(sessionId);
  const knownModels = all.filter((model) => hasKnownCost(model.provider, model.id));
  const zeroModels = orderedZeroModels(knownModels, config);
  const availableRefs = new Set(registry.getAvailable().map(canonicalModelRef));
  const priority = new Map(config.priority.map((ref, index) => [ref, index]));
  const candidates = zeroModels.map((model): CheapskateCandidateDto => {
    const ref = canonicalModelRef(model);
    return {
      ref,
      provider: model.provider,
      provider_name: registry.getProviderDisplayName(model.provider),
      model: model.id,
      name: model.name,
      context_window: model.contextWindow,
      max_tokens: model.maxTokens,
      reasoning: model.reasoning,
      inputs: [...model.input],
      configured: registry.hasConfiguredAuth(model),
      provider_enabled: isProviderEnabled(config, model.provider),
      model_enabled: isModelEnabled(config, ref),
      in_scope: scopeAllows(model, scopedModels),
      state: candidateState(model, registry, availableRefs, config, scopedModels),
      priority: priority.get(ref) ?? null,
      active: ref === activeRef,
      health: healthDto(ref),
    };
  });

  const eligible = resolveEligibleModels({ registry, hasKnownCost, config, scopedModels }).filter((model) => healthAllowsSelection(canonicalModelRef(model)));
  const excludedCosts = { positive: 0, unknown_or_malformed: 0, recursive: 0 };
  for (const model of all) {
    if (model.provider === "cheapskate") {
      excludedCosts.recursive += 1;
      continue;
    }
    if (!hasKnownCost(model.provider, model.id)) {
      excludedCosts.unknown_or_malformed += 1;
      continue;
    }
    const classification = classifyCatalogueCost(model);
    if (classification === "positive") excludedCosts.positive += 1;
    if (classification === "unknown_or_malformed") excludedCosts.unknown_or_malformed += 1;
  }

  let emptyReason: string | null = null;
  if (!config.enabled) emptyReason = "Cheapskate is disabled.";
  else if (zeroModels.length === 0) emptyReason = "The current catalogue contains no models with exact zero pricing.";
  else if (!candidates.some((candidate) => candidate.configured)) emptyReason = "Zero-cost catalogue models exist, but none of their providers has configured credentials.";
  else if (!candidates.some((candidate) => candidate.in_scope)) emptyReason = "Zero-cost catalogue models exist, but the current session scope excludes them.";
  else if (eligible.length === 0) emptyReason = "All configured zero-cost models are disabled or temporarily unhealthy.";

  return {
    ok: true,
    config,
    virtual_model_registered: eligible.length > 0,
    active_ref: activeRef,
    candidates,
    excluded_costs: excludedCosts,
    empty_reason: emptyReason,
  };
}
