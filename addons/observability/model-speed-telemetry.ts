import { graphiteSegment } from "./usage-telemetry.js";

export interface ModelTimingFields {
  callDurationMs: number | null;
  responseDurationMs: number | null;
  responseStartLatencyMs: number | null;
  timeToFirstOutputMs: number | null;
  timeToFirstTextMs: number | null;
  generationDurationMs: number | null;
  textGenerationDurationMs: number | null;
}

export interface ModelUsageFields {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
}

export interface ModelSpeedTelemetry {
  timing: ModelTimingFields;
  usage: ModelUsageFields;
  outputTokensPerSecond: number | null;
  nonReasoningOutputTokensPerSecond: number | null;
}

function finiteNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export function readModelTiming(record: Record<string, unknown>): ModelTimingFields {
  return {
    callDurationMs: finiteNumber(record, ["callDurationMs", "call_duration_ms"]),
    responseDurationMs: finiteNumber(record, ["responseDurationMs", "response_duration_ms", "durationMs", "duration_ms"]),
    responseStartLatencyMs: finiteNumber(record, ["responseStartLatencyMs", "response_start_latency_ms"]),
    timeToFirstOutputMs: finiteNumber(record, ["timeToFirstOutputMs", "time_to_first_output_ms"]),
    timeToFirstTextMs: finiteNumber(record, ["timeToFirstTextMs", "time_to_first_text_ms"]),
    generationDurationMs: finiteNumber(record, ["generationDurationMs", "generation_duration_ms"]),
    textGenerationDurationMs: finiteNumber(record, ["textGenerationDurationMs", "text_generation_duration_ms"]),
  };
}

export function readModelUsage(usage: unknown): ModelUsageFields {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return { inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null };
  }
  const record = usage as Record<string, unknown>;
  return {
    inputTokens: finiteNumber(record, ["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]),
    outputTokens: finiteNumber(record, ["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"]),
    reasoningTokens: finiteNumber(record, ["reasoning", "reasoningTokens", "reasoning_tokens"]),
    cacheReadTokens: finiteNumber(record, ["cacheRead", "cacheReadTokens", "cache_read_tokens"]),
    cacheWriteTokens: finiteNumber(record, ["cacheWrite", "cacheWriteTokens", "cache_write_tokens"]),
    totalTokens: finiteNumber(record, ["totalTokens", "total_tokens"]),
  };
}

function tokensPerSecond(tokens: number | null, durationMs: number | null): number | null {
  if (tokens == null || tokens < 0 || durationMs == null || durationMs <= 0) return null;
  return tokens * 1000 / durationMs;
}

export function deriveModelSpeedTelemetry(record: Record<string, unknown>): ModelSpeedTelemetry {
  const timing = readModelTiming(record);
  const usage = readModelUsage(record.usage);
  const nonReasoningTokens = usage.outputTokens != null && usage.reasoningTokens != null
    ? Math.max(0, usage.outputTokens - usage.reasoningTokens)
    : null;
  return {
    timing,
    usage,
    // usage.output is provider-reported output and may include hidden reasoning.
    // Divide by the full observable response interval rather than only the
    // streamed-delta interval so hidden reasoning latency is not discarded.
    outputTokensPerSecond: tokensPerSecond(usage.outputTokens, timing.responseDurationMs),
    nonReasoningOutputTokensPerSecond: tokensPerSecond(nonReasoningTokens, timing.responseDurationMs),
  };
}

export function buildModelSpeedSpanAttributes(telemetry: ModelSpeedTelemetry): Record<string, number> {
  const attributes: Record<string, number> = {};
  const values: Array<[string, number | null]> = [
    ["piclaw.model.call_duration_ms", telemetry.timing.callDurationMs],
    ["piclaw.model.response_duration_ms", telemetry.timing.responseDurationMs],
    ["piclaw.model.response_start_latency_ms", telemetry.timing.responseStartLatencyMs],
    ["piclaw.model.time_to_first_output_ms", telemetry.timing.timeToFirstOutputMs],
    ["piclaw.model.time_to_first_text_ms", telemetry.timing.timeToFirstTextMs],
    ["piclaw.model.generation_duration_ms", telemetry.timing.generationDurationMs],
    ["piclaw.model.text_generation_duration_ms", telemetry.timing.textGenerationDurationMs],
    ["piclaw.model.output_tokens_per_second", telemetry.outputTokensPerSecond],
    ["piclaw.model.non_reasoning_output_tokens_per_second", telemetry.nonReasoningOutputTokensPerSecond],
    ["piclaw.model.reasoning_tokens", telemetry.usage.reasoningTokens],
  ];
  for (const [name, value] of values) if (value != null) attributes[name] = value;
  return attributes;
}

export function modelGraphitePrefix(model: string | null | undefined): string {
  const normalized = String(model ?? "").trim();
  const slash = normalized.indexOf("/");
  const provider = slash > 0 ? normalized.slice(0, slash) : "unknown";
  const modelId = slash > 0 ? normalized.slice(slash + 1) : normalized || "unknown";
  return `model.${graphiteSegment(provider)}.${graphiteSegment(modelId)}`;
}

export function buildModelSpeedGraphiteMetrics(
  model: string | null | undefined,
  telemetry: ModelSpeedTelemetry,
): Array<{ name: string; value: number }> {
  const prefix = modelGraphitePrefix(model);
  const values: Array<[string, number | null]> = [
    [`${prefix}.call.count`, 1],
    [`${prefix}.duration.call_ms`, telemetry.timing.callDurationMs],
    [`${prefix}.duration.response_ms`, telemetry.timing.responseDurationMs],
    [`${prefix}.duration.generation_ms`, telemetry.timing.generationDurationMs],
    [`${prefix}.duration.text_generation_ms`, telemetry.timing.textGenerationDurationMs],
    [`${prefix}.latency.response_start_ms`, telemetry.timing.responseStartLatencyMs],
    [`${prefix}.latency.first_output_ms`, telemetry.timing.timeToFirstOutputMs],
    [`${prefix}.latency.first_text_ms`, telemetry.timing.timeToFirstTextMs],
    [`${prefix}.throughput.output_tokens_per_second`, telemetry.outputTokensPerSecond],
    [`${prefix}.throughput.non_reasoning_output_tokens_per_second`, telemetry.nonReasoningOutputTokensPerSecond],
  ];
  return values.flatMap(([name, value]) => value == null ? [] : [{ name, value }]);
}
