import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

import type { ModelCostProvenance, RuntimeModelRegistry, ScopedModelLike } from "./shared.js";

export interface CheapskateRuntimeInteropBridge {
  getChatJid?: (defaultValue?: string) => string;
  getModelRegistry?: () => RuntimeModelRegistry;
  hasKnownModelCost?: ModelCostProvenance;
  streamSimple?: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
  getSessionId?: (chatJid?: string) => string | null;
  getScopedModels?: (chatJid?: string) => readonly ScopedModelLike[];
}

function bridge(): CheapskateRuntimeInteropBridge | null {
  try {
    return (globalThis as { __piclawRuntimeInterop?: CheapskateRuntimeInteropBridge }).__piclawRuntimeInterop || null;
  } catch {
    return null;
  }
}

export function runtimeModelRegistry(): RuntimeModelRegistry | null {
  try {
    return bridge()?.getModelRegistry?.() || null;
  } catch {
    return null;
  }
}

export function runtimeModelCostProvenance(): ModelCostProvenance {
  return (provider, modelId) => {
    try {
      return bridge()?.hasKnownModelCost?.(provider, modelId) === true;
    } catch {
      return false;
    }
  };
}

export function activeChatJid(defaultValue = ""): string {
  try {
    return String(bridge()?.getChatJid?.(defaultValue) || defaultValue).trim();
  } catch {
    return defaultValue;
  }
}

export function runtimeStreamSimple(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream | null {
  try {
    return bridge()?.streamSimple?.(model, context, options) || null;
  } catch {
    return null;
  }
}

export function runtimeSessionId(chatJid = activeChatJid("")): string | null {
  try {
    return bridge()?.getSessionId?.(chatJid) || null;
  } catch {
    return null;
  }
}

export function runtimeScopedModels(chatJid = activeChatJid("")): readonly ScopedModelLike[] {
  try {
    return bridge()?.getScopedModels?.(chatJid) || [];
  } catch {
    return [];
  }
}

export function isVirtualCheapskateModel(model: Model<any> | null | undefined): boolean {
  return model?.provider === "cheapskate" && model.id === "auto";
}
