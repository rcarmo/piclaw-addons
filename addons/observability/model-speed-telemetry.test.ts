import { expect, test } from "bun:test";

import {
  buildModelSpeedGraphiteMetrics,
  buildModelSpeedSpanAttributes,
  deriveModelSpeedTelemetry,
  modelGraphitePrefix,
} from "./model-speed-telemetry.ts";

test("derives reported and non-reasoning throughput from authoritative intervals", () => {
  const telemetry = deriveModelSpeedTelemetry({
    callDurationMs: 2_000,
    responseDurationMs: 1_600,
    responseStartLatencyMs: 400,
    timeToFirstOutputMs: 600,
    timeToFirstTextMs: 1_000,
    generationDurationMs: 1_300,
    textGenerationDurationMs: 800,
    usage: { input: 100, output: 80, reasoning: 40, cacheRead: 20, cacheWrite: 0, totalTokens: 200 },
  });

  expect(telemetry.outputTokensPerSecond).toBe(50);
  expect(telemetry.nonReasoningOutputTokensPerSecond).toBe(25);
  expect(telemetry.usage.reasoningTokens).toBe(40);
  expect(buildModelSpeedSpanAttributes(telemetry)).toMatchObject({
    "piclaw.model.call_duration_ms": 2_000,
    "piclaw.model.response_duration_ms": 1_600,
    "piclaw.model.response_start_latency_ms": 400,
    "piclaw.model.time_to_first_output_ms": 600,
    "piclaw.model.time_to_first_text_ms": 1_000,
    "piclaw.model.generation_duration_ms": 1_300,
    "piclaw.model.text_generation_duration_ms": 800,
    "piclaw.model.output_tokens_per_second": 50,
    "piclaw.model.non_reasoning_output_tokens_per_second": 25,
    "piclaw.model.reasoning_tokens": 40,
  });
});

test("omits unsupported rates and accepts legacy duration and usage field names", () => {
  const telemetry = deriveModelSpeedTelemetry({
    duration_ms: 2_000,
    usage: { output_tokens: 20, total_tokens: 40 },
  });
  expect(telemetry.timing.responseDurationMs).toBe(2_000);
  expect(telemetry.outputTokensPerSecond).toBe(10);
  expect(telemetry.nonReasoningOutputTokensPerSecond).toBeNull();
  expect(buildModelSpeedSpanAttributes(telemetry)).not.toHaveProperty("piclaw.model.non_reasoning_output_tokens_per_second");
});

test("does not divide by zero or emit rates without output usage", () => {
  expect(deriveModelSpeedTelemetry({ responseDurationMs: 0, usage: { output: 20 } }).outputTokensPerSecond).toBeNull();
  expect(deriveModelSpeedTelemetry({ responseDurationMs: 100, usage: null }).outputTokensPerSecond).toBeNull();
});

test("builds provider/model-dimensional Graphite metrics", () => {
  const telemetry = deriveModelSpeedTelemetry({
    callDurationMs: 1_000,
    responseDurationMs: 800,
    responseStartLatencyMs: 200,
    timeToFirstOutputMs: 300,
    timeToFirstTextMs: 400,
    generationDurationMs: 600,
    textGenerationDurationMs: 500,
    usage: { output: 40, reasoning: 10 },
  });
  expect(modelGraphitePrefix("github-copilot/gpt-5.6-sol")).toBe("model.github-copilot.gpt-5_6-sol");
  expect(buildModelSpeedGraphiteMetrics("github-copilot/gpt-5.6-sol", telemetry)).toEqual(expect.arrayContaining([
    { name: "model.github-copilot.gpt-5_6-sol.call.count", value: 1 },
    { name: "model.github-copilot.gpt-5_6-sol.latency.first_output_ms", value: 300 },
    { name: "model.github-copilot.gpt-5_6-sol.throughput.output_tokens_per_second", value: 50 },
    { name: "model.github-copilot.gpt-5_6-sol.throughput.non_reasoning_output_tokens_per_second", value: 37.5 },
  ]));
});
