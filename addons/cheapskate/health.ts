import type { AssistantMessage, ProviderResponse } from "@earendil-works/pi-ai";

import type { CandidateHealthDto, CanonicalModelRef } from "./shared.js";

export type HealthState = CandidateHealthDto["state"];

export interface CandidateHealth {
  state: HealthState;
  cooldownUntil: number;
  consecutiveErrors: number;
  lastError: string | null;
  lastSuccessAt: number | null;
}

const MAX_HEALTH_ENTRIES = 2_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
const healthByRef = new Map<CanonicalModelRef, CandidateHealth>();

export function getCandidateHealth(ref: CanonicalModelRef, now = Date.now()): CandidateHealth {
  let health = healthByRef.get(ref);
  if (!health) {
    if (healthByRef.size >= MAX_HEALTH_ENTRIES) {
      const oldest = healthByRef.keys().next().value as CanonicalModelRef | undefined;
      if (oldest) healthByRef.delete(oldest);
    }
    health = { state: "healthy", cooldownUntil: 0, consecutiveErrors: 0, lastError: null, lastSuccessAt: null };
    healthByRef.set(ref, health);
  }
  if (health.state === "cooldown" && health.cooldownUntil <= now) {
    health.state = "healthy";
    health.cooldownUntil = 0;
  }
  return health;
}

export function healthAllowsSelection(ref: CanonicalModelRef, now = Date.now()): boolean {
  return getCandidateHealth(ref, now).state === "healthy";
}

function headerValue(headers: Record<string, string>, names: string[]): string | undefined {
  for (const [name, value] of Object.entries(headers || {})) {
    if (names.some((candidate) => candidate.toLowerCase() === name.toLowerCase())) return value;
  }
  return undefined;
}

export function parseRetryAfterMs(response: ProviderResponse, now = Date.now()): number | null {
  const retryAfter = headerValue(response.headers, ["retry-after"]);
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_COOLDOWN_MS, seconds * 1_000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(MAX_COOLDOWN_MS, Math.max(0, at - now));
  }
  const reset = headerValue(response.headers, [
    "x-ratelimit-reset",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "ratelimit-reset",
  ]);
  if (reset) {
    const numeric = Number(reset);
    if (Number.isFinite(numeric) && numeric >= 0) {
      const absoluteMs = numeric > 10_000_000_000 ? numeric : numeric > 1_000_000_000 ? numeric * 1_000 : now + numeric * 1_000;
      return Math.min(MAX_COOLDOWN_MS, Math.max(0, absoluteMs - now));
    }
  }
  return null;
}

export type FailureKind = "rate_limit" | "credential" | "missing_model" | "context" | "transient" | "permanent" | "aborted";

export function responseFromErrorMessage(message: AssistantMessage): ProviderResponse | null {
  const match = /^\s*(\d{3})\s*[: ]/.exec(String(message.errorMessage || ""));
  return match ? { status: Number(match[1]), headers: {} } : null;
}

export function classifyFailure(response: ProviderResponse | null, message: AssistantMessage): FailureKind {
  if (message.stopReason === "aborted") return "aborted";
  const status = Number(response?.status || 0);
  const text = String(message.errorMessage || "");
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|authentication/i.test(text)) return "credential";
  if (status === 404 || /model.*(?:not found|does not exist|unavailable)|unknown model/i.test(text)) return "missing_model";
  if (status === 413 || /context length|context window|maximum context|too many tokens|input (?:is )?too long|prompt (?:is )?too long/i.test(text)) return "context";
  if (status === 429 || /rate.?limit|too many requests|quota|resource.*exhausted/i.test(text)) return "rate_limit";
  if (status >= 500 || status === 408 || status === 425 || /timeout|timed out|network|connection|temporar|overload|unavailable/i.test(text)) return "transient";
  return "permanent";
}

export function recordCandidateFailure(
  ref: CanonicalModelRef,
  kind: FailureKind,
  message: string,
  response: ProviderResponse | null,
  now = Date.now(),
): void {
  const health = getCandidateHealth(ref, now);
  health.consecutiveErrors += 1;
  health.lastError = message || kind;
  if (kind === "context") return;
  if (kind === "credential") {
    health.state = "credential_fault";
    health.cooldownUntil = 0;
  } else if (kind === "missing_model") {
    health.state = "missing_model";
    health.cooldownUntil = 0;
  } else if (kind === "rate_limit" || kind === "transient") {
    health.state = "cooldown";
    const headerDelay = response ? parseRetryAfterMs(response, now) : null;
    const fallback = Math.min(30_000 * 2 ** Math.max(0, health.consecutiveErrors - 1), MAX_COOLDOWN_MS);
    health.cooldownUntil = now + Math.max(1_000, headerDelay ?? fallback);
  }
}

export function recordCandidateSuccess(ref: CanonicalModelRef, now = Date.now()): void {
  const health = getCandidateHealth(ref, now);
  health.state = "healthy";
  health.cooldownUntil = 0;
  health.consecutiveErrors = 0;
  health.lastError = null;
  health.lastSuccessAt = now;
}

export function quarantineCostViolation(ref: CanonicalModelRef, providerCost: number, now = Date.now()): void {
  const health = getCandidateHealth(ref, now);
  health.state = "cost_violation";
  health.cooldownUntil = 0;
  health.lastError = `Provider reported a positive charge (${providerCost}).`;
  health.consecutiveErrors += 1;
}

export function healthDto(ref: CanonicalModelRef, now = Date.now()): CandidateHealthDto {
  const health = getCandidateHealth(ref, now);
  return {
    state: health.state,
    cooldown_until: health.cooldownUntil > now ? new Date(health.cooldownUntil).toISOString() : null,
    last_error: health.lastError,
    last_success_at: health.lastSuccessAt ? new Date(health.lastSuccessAt).toISOString() : null,
  };
}

export function resetCandidateHealth(ref: CanonicalModelRef): void {
  healthByRef.delete(ref);
}

export function resetCheapskateHealthForTests(): void {
  healthByRef.clear();
}
