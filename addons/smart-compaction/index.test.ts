import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCompatibilityCompletionOptions, resolveCompatibilityRequestAuth } from "./src/model-execution.ts";

const addonDir = import.meta.dir;

describe("smart-compaction addon", () => {
  test("exports an extension entrypoint", async () => {
    const mod = await import("./index.ts");
    expect(typeof mod.default).toBe("function");
    expect(typeof mod.smartCompaction).toBe("function");
  });

  test("ports core stale-ctx UI resilience", () => {
    const source = readFileSync(resolve(addonDir, "index.ts"), "utf8");
    expect(source).toContain("function resilientUi");
    expect(source).toContain("makeResilientCtx(rawCtx as any)");
    expect(source).toContain("/stale|disposed|invalid/i");
  });

  test("ports core progressive merge safety guards", () => {
    const source = readFileSync(resolve(addonDir, "src", "progressive.ts"), "utf8");
    expect(source).toContain("MAX_PROGRESSIVE_MERGE_PASSES = 12");
    expect(source).toContain("Progressive compaction merge made no progress");
    expect(source).toContain("Progressive compaction time budget exhausted during merge pass");
    expect(source).toContain("Progressive compaction time budget exhausted before final merge");
    expect(source).toContain("timeoutMs: input.timeoutMs");
    expect(source).toContain("startedAt: input.startedAt");
  });

  test("resolves and forwards the complete public compatibility auth contract", async () => {
    const model = {
      provider: "custom",
      id: "model",
      name: "Model",
      api: "openai-completions",
      baseUrl: "https://credential-specific.example/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    } as any;
    const signal = new AbortController().signal;
    const onPayload = (payload: unknown) => payload;
    const onResponse = () => {};
    const resolution = await resolveCompatibilityRequestAuth({
      async getApiKeyAndHeaders(received: unknown) {
        expect(received).toBe(model);
        return {
          ok: true as const,
          apiKey: "resolved-key",
          headers: { "x-provider": "resolved", "x-shared": "auth", "x-delete": "auth" },
          env: { AWS_REGION: "eu-west-1", SHARED_ENV: "auth" },
        };
      },
    }, model);

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error(resolution.error);
    const options = buildCompatibilityCompletionOptions(model, resolution.auth, {
      maxTokens: 123,
      signal,
      onPayload,
      onResponse,
      apiKey: "request-key",
      headers: { "x-request": "yes", "x-shared": "request", "x-delete": null },
      env: { HTTPS_PROXY: "http://proxy.test", SHARED_ENV: "request" },
    });
    expect(model.baseUrl).toBe("https://credential-specific.example/v1");
    expect(options).toEqual({
      maxTokens: 123,
      signal,
      onPayload,
      onResponse,
      apiKey: "request-key",
      headers: {
        "x-provider": "resolved",
        "x-request": "yes",
        "x-shared": "request",
        "x-delete": null,
      },
      env: {
        AWS_REGION: "eu-west-1",
        HTTPS_PROXY: "http://proxy.test",
        SHARED_ENV: "request",
      },
      reasoning: "high",
    });
  });

  test("preserves explicit reasoning, falls back to resolved auth, and reports auth failures", async () => {
    const model = { provider: "custom", id: "model", reasoning: true } as any;
    expect(buildCompatibilityCompletionOptions(model, { apiKey: "resolved-key" }, { reasoning: "low" }))
      .toMatchObject({ apiKey: "resolved-key", reasoning: "low" });
    await expect(resolveCompatibilityRequestAuth({
      async getApiKeyAndHeaders() { return { ok: false as const, error: "not configured" }; },
    }, model)).resolves.toEqual({ ok: false, error: "not configured" });
  });
});
