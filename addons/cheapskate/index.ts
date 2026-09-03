import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { classifyCatalogueCost, orderedZeroModels } from "./catalogue.js";
import {
  applyCheapskateConfigPatch,
  loadCheapskateConfig,
  resetCheapskateConfigForTests,
  saveCheapskateConfig,
} from "./config.js";
import { resetCandidateHealth, resetCheapskateHealthForTests } from "./health.js";
import { isVirtualProviderRegistered, reconcileVirtualProvider } from "./provider.js";
import { resetCheapskateRouterForTests } from "./router.js";
import { activeChatJid, isVirtualCheapskateModel, runtimeModelCostProvenance, runtimeModelRegistry, runtimeScopedModels, runtimeSessionId } from "./runtime.js";
import {
  CHEAPSKATE_PROVIDER_ID,
  canonicalModelRef,
  type AddonConfigApiRegistrar,
  type CanonicalModelRef,
  type CheapskateConfigPatch,
} from "./shared.js";
import { buildCheapskateStatus } from "./status.js";

function zeroCatalogueSets(): { providers: Set<string>; models: Set<CanonicalModelRef> } {
  const registry = runtimeModelRegistry();
  const hasKnownCost = runtimeModelCostProvenance();
  const models = registry ? orderedZeroModels(registry.getAll().filter((model) => hasKnownCost(model.provider, model.id)), loadCheapskateConfig()) : [];
  return {
    providers: new Set(models.map((model) => model.provider)),
    models: new Set(models.map(canonicalModelRef)),
  };
}

function currentStatus(chatJid = activeChatJid("")) {
  return buildCheapskateStatus(runtimeModelRegistry(), loadCheapskateConfig(), runtimeScopedModels(chatJid), runtimeSessionId(chatJid), runtimeModelCostProvenance());
}

async function saveConfig(payload: unknown) {
  const patch = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as CheapskateConfigPatch
    : {};
  const current = loadCheapskateConfig();
  const valid = zeroCatalogueSets();
  const next = applyCheapskateConfigPatch(current, patch, valid.providers, valid.models);
  for (const ref of Object.keys(patch.models || {}) as CanonicalModelRef[]) resetCandidateHealth(ref);
  saveCheapskateConfig(next);
  reconcileVirtualProvider();
  return currentStatus();
}

function installConfigApi(): void {
  const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
  if (typeof registerAddonConfigApi !== "function") return;
  registerAddonConfigApi(CHEAPSKATE_PROVIDER_ID, "config", {
    get: async (_payload, req) => currentStatus(new URL(req.url).searchParams.get("chat_jid") || activeChatJid("")),
    set: async (payload, req) => {
      const result = await saveConfig(payload);
      const chatJid = new URL(req.url).searchParams.get("chat_jid") || activeChatJid("");
      return buildCheapskateStatus(runtimeModelRegistry(), result.config, runtimeScopedModels(chatJid), runtimeSessionId(chatJid), runtimeModelCostProvenance());
    },
  }, import.meta.dir);
}

installConfigApi();

const cheapskate: ExtensionFactory = (pi: ExtensionAPI) => {
  reconcileVirtualProvider(pi);

  pi.on("session_start", () => {
    reconcileVirtualProvider(pi);
  });

  pi.on("before_agent_start", (event, ctx) => {
    reconcileVirtualProvider(pi);
    if (!isVirtualCheapskateModel(ctx.model)) return;
    const status = buildCheapskateStatus(runtimeModelRegistry(), loadCheapskateConfig(), ctx.scopedModels, ctx.sessionManager.getSessionId(), runtimeModelCostProvenance());
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Cheapskate mode\nRequests use only explicitly enabled catalogue models whose base and tiered token prices are exactly zero. The physical route is recorded in responseModel.`,
    };
  });

  pi.registerTool({
    name: "cheapskate",
    label: "cheapskate",
    description: "Inspect or rotate the catalogue-backed zero-cost model router.",
    promptSnippet: "cheapskate: inspect eligible zero-cost catalogue models, health, and active routing.",
    parameters: Type.Object({
      action: Type.String({ enum: ["status", "list", "usage", "rotate"], description: "Management action." }),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const status = buildCheapskateStatus(runtimeModelRegistry(), loadCheapskateConfig(), ctx.scopedModels, ctx.sessionManager.getSessionId(), runtimeModelCostProvenance());
      if (params.action === "rotate") {
        return {
          content: [{ type: "text", text: "Cheapskate uses request-local routing. Reorder enabled zero-cost models in Settings → Cheapskate to change priority." }],
          details: status,
        };
      }
      if (params.action === "usage") {
        return {
          content: [{ type: "text", text: "Cheapskate no longer invents RPM/TPM/day quotas. Candidate health and provider reset times are shown in Settings → Cheapskate." }],
          details: status,
        };
      }
      if (params.action === "list") {
        const entries = status.candidates.map((candidate) => `- ${candidate.ref}: ${candidate.state}${candidate.active ? " (active)" : ""}`);
        return {
          content: [{ type: "text", text: entries.length ? `${entries.length} catalogue-zero model(s):\n${entries.join("\n")}` : status.empty_reason || "No catalogue-zero models." }],
          details: status,
        };
      }
      return {
        content: [{
          type: "text",
          text: `Cheapskate: ${status.candidates.length} catalogue-zero model(s), ${status.candidates.filter((candidate) => candidate.state === "eligible").length} eligible.${status.active_ref ? ` Active: ${status.active_ref}.` : ""}${status.empty_reason ? ` ${status.empty_reason}` : ""}`,
        }],
        details: status,
      };
    },
  });
};

export function resetCheapskateForTests(): void {
  resetCheapskateConfigForTests();
  resetCheapskateHealthForTests();
  resetCheapskateRouterForTests();
}

export default cheapskate;
export {
  cheapskate,
  applyCheapskateConfigPatch,
  buildCheapskateStatus,
  canonicalModelRef,
  classifyCatalogueCost,
  isVirtualProviderRegistered,
  loadCheapskateConfig,
  orderedZeroModels,
  reconcileVirtualProvider,
  saveCheapskateConfig,
};
