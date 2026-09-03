import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageDiagnostic,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderResponse,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { modelSupportsRequest, requestRequirements, resolveEligibleModels } from "./catalogue.js";
import { loadCheapskateConfig } from "./config.js";
import {
  classifyFailure,
  healthAllowsSelection,
  quarantineCostViolation,
  responseFromErrorMessage,
  recordCandidateFailure,
  recordCandidateSuccess,
} from "./health.js";
import {
  CHEAPSKATE_MODEL_ID,
  CHEAPSKATE_PROVIDER_ID,
  canonicalModelRef,
  type CanonicalModelRef,
  type ModelCostProvenance,
  type RuntimeModelRegistry,
  type ScopedModelLike,
} from "./shared.js";

const MAX_FAILOVER_ATTEMPTS = 3;
const stickyBySession = new Map<string, CanonicalModelRef>();
const MAX_STICKY_SESSIONS = 1_000;

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function virtualError(model: Model<any>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: CHEAPSKATE_PROVIDER_ID,
    model: CHEAPSKATE_MODEL_ID,
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function physicalRouteDiagnostic(ref: CanonicalModelRef, attempts: number): AssistantMessageDiagnostic {
  return { type: "cheapskate.route", timestamp: Date.now(), details: { physical_model: ref, attempts } };
}

function remapMessage(message: AssistantMessage, ref: CanonicalModelRef, attempts: number): AssistantMessage {
  return {
    ...message,
    provider: CHEAPSKATE_PROVIDER_ID,
    model: CHEAPSKATE_MODEL_ID,
    responseModel: ref,
    diagnostics: [...(message.diagnostics || []), physicalRouteDiagnostic(ref, attempts)],
  };
}

function remapEvent(event: AssistantMessageEvent, ref: CanonicalModelRef, attempts: number): AssistantMessageEvent {
  switch (event.type) {
    case "done":
      return { ...event, message: remapMessage(event.message, ref, attempts) };
    case "error":
      return { ...event, error: remapMessage(event.error, ref, attempts) };
    case "toolcall_end":
      return { ...event, partial: remapMessage(event.partial, ref, attempts) };
    case "text_end":
    case "thinking_end":
      return { ...event, partial: remapMessage(event.partial, ref, attempts) };
    default:
      return { ...event, partial: remapMessage(event.partial, ref, attempts) } as AssistantMessageEvent;
  }
}

function outputStarted(event: AssistantMessageEvent): boolean {
  return event.type !== "start" && event.type !== "done" && event.type !== "error";
}

function sessionKey(options?: SimpleStreamOptions): string {
  const value = typeof options?.sessionId === "string" ? options.sessionId.trim() : "";
  return value || "anonymous";
}

function rememberSticky(sessionId: string, ref: CanonicalModelRef): void {
  if (stickyBySession.size >= MAX_STICKY_SESSIONS && !stickyBySession.has(sessionId)) {
    const oldest = stickyBySession.keys().next().value as string | undefined;
    if (oldest) stickyBySession.delete(oldest);
  }
  stickyBySession.delete(sessionId);
  stickyBySession.set(sessionId, ref);
}

export function activeRefForSession(sessionId: string | null | undefined): CanonicalModelRef | null {
  const key = String(sessionId || "").trim();
  return key ? stickyBySession.get(key) || null : null;
}

function orderWithSticky(models: Model<any>[], sessionId: string): Model<any>[] {
  const sticky = stickyBySession.get(sessionId);
  if (!sticky) return models;
  return [...models].sort((a, b) => Number(canonicalModelRef(b) === sticky) - Number(canonicalModelRef(a) === sticky));
}

export interface RouterRuntime {
  registry: RuntimeModelRegistry;
  hasKnownCost: ModelCostProvenance;
  scopedModels: () => readonly ScopedModelLike[];
  streamSimple: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
}

export function createCheapskateStream(
  virtualModel: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  runtime: RouterRuntime,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  void runRouter(outer, virtualModel, context, options, runtime);
  return outer;
}

async function runRouter(
  outer: AssistantMessageEventStream,
  virtualModel: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  runtime: RouterRuntime,
): Promise<void> {
  const attempted = new Set<CanonicalModelRef>();
  const sessionId = sessionKey(options);
  const scopedModels = [...runtime.scopedModels()];
  const requirements = requestRequirements(context, options?.maxTokens);
  let lastError: AssistantMessage | null = null;

  try {
    for (let attempt = 1; attempt <= MAX_FAILOVER_ATTEMPTS; attempt += 1) {
      const config = loadCheapskateConfig();
      if (!config.enabled) break;
      const candidates = orderWithSticky(resolveEligibleModels({
        registry: runtime.registry,
        hasKnownCost: runtime.hasKnownCost,
        config,
        scopedModels,
        requirements,
        excludedRefs: attempted,
      }).filter((model) => healthAllowsSelection(canonicalModelRef(model))), sessionId);
      const physicalModel = candidates[0];
      if (!physicalModel) break;
      const ref = canonicalModelRef(physicalModel);
      attempted.add(ref);

      if (!modelSupportsRequest(physicalModel, requirements)) continue;

      let response: ProviderResponse | null = null;
      const callerOnResponse = options?.onResponse;
      // The incoming credentials belong to cheapskate/auto. Physical auth,
      // provider headers and provider-scoped env must be resolved again by the
      // shared ModelRuntime for the selected catalogue model.
      const requestOptions: SimpleStreamOptions = { ...(options || {}) };
      const callerFetch = requestOptions.fetch;
      delete requestOptions.apiKey;
      delete requestOptions.headers;
      delete requestOptions.env;
      delete requestOptions.fetch;
      const fetchImpl = callerFetch || globalThis.fetch;
      const captureFetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const nextResponse = await fetchImpl(input, init);
          response = { status: nextResponse.status, headers: Object.fromEntries(nextResponse.headers.entries()) };
          return nextResponse;
        },
        {
          preconnect: typeof fetchImpl.preconnect === "function"
            ? fetchImpl.preconnect.bind(fetchImpl)
            : () => {},
        },
      );
      const physicalOptions: SimpleStreamOptions = {
        ...requestOptions,
        maxRetries: 0,
        fetch: captureFetch,
        onResponse: async (nextResponse, responseModel) => {
          response = nextResponse;
          await callerOnResponse?.(nextResponse, responseModel);
        },
      };
      const inner = runtime.streamSimple(physicalModel, context, physicalOptions);
      let emitted = false;
      let pendingStart: Extract<AssistantMessageEvent, { type: "start" }> | null = null;
      let terminal: AssistantMessage | null = null;

      for await (const event of inner) {
        if (event.type === "start") {
          pendingStart = event;
          continue;
        }
        if (event.type === "done") {
          terminal = event.message;
          const providerCost = (terminal.usage as typeof terminal.usage & { providerCost?: number }).providerCost;
          if (typeof providerCost === "number" && Number.isFinite(providerCost) && providerCost > 0) {
            quarantineCostViolation(ref, providerCost);
          } else {
            recordCandidateSuccess(ref);
          }
          rememberSticky(sessionId, ref);
          if (pendingStart) outer.push(remapEvent(pendingStart, ref, attempt));
          const mapped = remapEvent(event, ref, attempt);
          outer.push(mapped);
          outer.end((mapped as Extract<AssistantMessageEvent, { type: "done" }>).message);
          return;
        }
        if (event.type === "error") {
          terminal = event.error;
          lastError = remapMessage(event.error, ref, attempt);
          continue;
        }
        if (outputStarted(event)) {
          if (!emitted && pendingStart) outer.push(remapEvent(pendingStart, ref, attempt));
          emitted = true;
        }
        outer.push(remapEvent(event, ref, attempt));
      }

      terminal ??= await inner.result();
      if (terminal.stopReason !== "error" && terminal.stopReason !== "aborted") {
        const mapped = remapMessage(terminal, ref, attempt);
        recordCandidateSuccess(ref);
        rememberSticky(sessionId, ref);
        outer.push({ type: "done", reason: terminal.stopReason as "stop" | "length" | "toolUse" | "deferred", message: mapped });
        outer.end(mapped);
        return;
      }

      const effectiveResponse = response ?? responseFromErrorMessage(terminal);
      const failure = classifyFailure(effectiveResponse, terminal);
      recordCandidateFailure(ref, failure, terminal.errorMessage || failure, effectiveResponse);
      lastError = remapMessage(terminal, ref, attempt);
      const retryable = failure === "rate_limit" || failure === "transient" || failure === "context" || failure === "missing_model" || failure === "credential";
      if (emitted || !retryable) {
        outer.push({ type: "error", reason: terminal.stopReason === "aborted" ? "aborted" : "error", error: lastError });
        outer.end(lastError);
        return;
      }
    }

    const error = lastError ?? virtualError(virtualModel, "No eligible zero-cost catalogue model is available for this request.");
    outer.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
    outer.end(error);
  } catch (error) {
    const message = virtualError(virtualModel, error);
    outer.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: message });
    outer.end(message);
  }
}

export function resetCheapskateRouterForTests(): void {
  stickyBySession.clear();
}
