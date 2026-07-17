import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";

export type CompatibilityRequestAuth = {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
};

export type CompatibilityAuthResolution =
  | { ok: true; auth: CompatibilityRequestAuth }
  | { ok: false; error: string };

/**
 * External extensions receive ModelRegistry rather than the process ModelRuntime.
 * Resolve its complete public compatibility auth contract once per compaction.
 * The canonical model object is forwarded unchanged so its composed baseUrl is
 * preserved; apiKey, headers, and provider-scoped env travel in request options.
 */
export async function resolveCompatibilityRequestAuth(
  registry: Pick<ExtensionContext["modelRegistry"], "getApiKeyAndHeaders">,
  model: Model<Api>,
): Promise<CompatibilityAuthResolution> {
  const resolved = await registry.getApiKeyAndHeaders(model);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    auth: {
      apiKey: resolved.apiKey,
      headers: resolved.headers,
      env: resolved.env,
    },
  };
}

export function buildCompatibilityCompletionOptions(
  model: Model<Api>,
  auth: CompatibilityRequestAuth,
  options: SimpleStreamOptions,
): SimpleStreamOptions {
  return {
    ...options,
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    ...(model.reasoning ? { reasoning: options.reasoning ?? "high" } : {}),
  };
}

export async function completeWithCompatibilityAuth(
  model: Model<Api>,
  context: Context,
  auth: CompatibilityRequestAuth,
  options: SimpleStreamOptions,
) {
  return completeSimple(model, context, buildCompatibilityCompletionOptions(model, auth, options));
}
