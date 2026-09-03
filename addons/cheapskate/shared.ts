import type { Model } from "@earendil-works/pi-ai";

export const CHEAPSKATE_PROVIDER_ID = "cheapskate";
export const CHEAPSKATE_MODEL_ID = "auto";
export const CONFIG_VERSION = 2;

export type CanonicalModelRef = `${string}/${string}`;

export interface CheapskateProviderConfig {
  enabled: boolean;
}

export interface CheapskateModelConfig {
  enabled: boolean;
}

export interface CheapskateConfig {
  version: typeof CONFIG_VERSION;
  enabled: boolean;
  providers: Record<string, CheapskateProviderConfig>;
  models: Record<string, CheapskateModelConfig>;
  priority: CanonicalModelRef[];
}

export type CandidateState = "eligible" | "needs_credentials" | "disabled" | "excluded_by_scope" | "unhealthy";

export interface CandidateHealthDto {
  state: "healthy" | "cooldown" | "credential_fault" | "missing_model" | "cost_violation";
  cooldown_until: string | null;
  last_error: string | null;
  last_success_at: string | null;
}

export interface CheapskateCandidateDto {
  ref: CanonicalModelRef;
  provider: string;
  provider_name: string;
  model: string;
  name: string;
  context_window: number;
  max_tokens: number;
  reasoning: boolean;
  inputs: Array<"text" | "image">;
  configured: boolean;
  provider_enabled: boolean;
  model_enabled: boolean;
  in_scope: boolean;
  state: CandidateState;
  priority: number | null;
  active: boolean;
  health: CandidateHealthDto;
}

export interface ExcludedCostSummary {
  positive: number;
  unknown_or_malformed: number;
  recursive: number;
}

export interface CheapskateStatusDto {
  ok: true;
  config: CheapskateConfig;
  virtual_model_registered: boolean;
  active_ref: CanonicalModelRef | null;
  candidates: CheapskateCandidateDto[];
  excluded_costs: ExcludedCostSummary;
  empty_reason: string | null;
}

export interface CheapskateConfigPatch {
  enabled?: boolean;
  providers?: Record<string, { enabled?: boolean }>;
  models?: Record<string, { enabled?: boolean }>;
  priority?: string[];
}

export type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: {
    get?: (payload: unknown, req: Request) => unknown | Promise<unknown>;
    set?: (payload: unknown, req: Request) => unknown | Promise<unknown>;
  },
  extensionPath?: string,
) => "created" | "updated";

export interface RuntimeModelRegistry {
  getAll(): Model<any>[];
  getAvailable(): Model<any>[];
  find(provider: string, modelId: string): Model<any> | undefined;
  hasConfiguredAuth(model: Model<any>): boolean;
  getProvider(provider: string): {
    readonly id: string;
    readonly name: string;
    streamSimple(model: Model<any>, context: import("@earendil-works/pi-ai").Context, options?: import("@earendil-works/pi-ai").SimpleStreamOptions): import("@earendil-works/pi-ai").AssistantMessageEventStream;
  } | undefined;
  getProviderDisplayName(provider: string): string;
  getApiKeyAndHeaders(model: Model<any>): Promise<
    | { ok: true; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string; env?: Record<string, string> }
    | { ok: false; error: string }
  >;
  registerProvider(providerName: string, config: import("@earendil-works/pi-coding-agent").ProviderConfig): void;
  unregisterProvider(providerName: string): void;
}

export type ModelCostProvenance = (provider: string, modelId: string) => boolean;

export interface ScopedModelLike {
  model: Model<any>;
  thinkingLevel?: string;
}

export function canonicalModelRef(model: Pick<Model<any>, "provider" | "id">): CanonicalModelRef {
  return `${model.provider}/${model.id}` as CanonicalModelRef;
}
