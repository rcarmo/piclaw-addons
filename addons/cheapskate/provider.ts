import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import { resolveEligibleModels } from "./catalogue.js";
import { loadCheapskateConfig } from "./config.js";
import { createCheapskateStream } from "./router.js";
import { activeChatJid, runtimeModelCostProvenance, runtimeModelRegistry, runtimeScopedModels, runtimeStreamSimple } from "./runtime.js";
import {
  CHEAPSKATE_MODEL_ID,
  CHEAPSKATE_PROVIDER_ID,
  type RuntimeModelRegistry,
} from "./shared.js";

function virtualModel(eligible: readonly Model<any>[]): ProviderModelConfig {
  // Advertise the safe intersection. Request-time routing can never promise more
  // than every enabled candidate supports.
  const contextWindow = Math.min(...eligible.map((model) => model.contextWindow));
  const maxTokens = Math.min(...eligible.map((model) => model.maxTokens));
  const supportsImages = eligible.every((model) => model.input.includes("image"));
  return {
    id: CHEAPSKATE_MODEL_ID,
    name: `Catalogue zero-cost router (${eligible.length} model${eligible.length === 1 ? "" : "s"})`,
    api: "openai-completions",
    reasoning: eligible.every((model) => model.reasoning),
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

function providerConfig(registry: RuntimeModelRegistry, eligible: readonly Model<any>[]): ProviderConfig {
  const hasKnownCost = runtimeModelCostProvenance();
  return {
    name: "Cheapskate",
    baseUrl: "https://cheapskate.invalid/v1",
    apiKey: "catalogue-zero-cost-router",
    api: "openai-completions",
    models: [virtualModel(eligible)],
    streamSimple: (model, context, options) => {
      const scopedModels = runtimeScopedModels(activeChatJid(""));
      return createCheapskateStream(model, context, options, {
        registry,
        hasKnownCost,
        scopedModels: () => scopedModels,
        streamSimple: (physicalModel, physicalContext, physicalOptions) => {
          const stream = runtimeStreamSimple(physicalModel, physicalContext, physicalOptions);
          if (!stream) throw new Error("Piclaw ModelRuntime stream interop is unavailable.");
          return stream;
        },
      });
    },
  };
}

function eligibleAtLoad(registry: RuntimeModelRegistry): Model<any>[] {
  return resolveEligibleModels({ registry, hasKnownCost: runtimeModelCostProvenance(), config: loadCheapskateConfig(), scopedModels: [], requireAvailable: true });
}

export function reconcileVirtualProvider(pi?: Pick<ExtensionAPI, "registerProvider" | "unregisterProvider">): boolean {
  const registry = runtimeModelRegistry();
  if (!registry) return false;
  const eligible = eligibleAtLoad(registry);
  const register = pi?.registerProvider.bind(pi) ?? registry.registerProvider.bind(registry);
  const unregister = pi?.unregisterProvider.bind(pi) ?? registry.unregisterProvider.bind(registry);
  if (eligible.length === 0) {
    if (registry.find(CHEAPSKATE_PROVIDER_ID, CHEAPSKATE_MODEL_ID)) unregister(CHEAPSKATE_PROVIDER_ID);
    return false;
  }
  register(CHEAPSKATE_PROVIDER_ID, providerConfig(registry, eligible));
  return true;
}

export function isVirtualProviderRegistered(): boolean {
  const registry = runtimeModelRegistry();
  return Boolean(registry?.find(CHEAPSKATE_PROVIDER_ID, CHEAPSKATE_MODEL_ID));
}
