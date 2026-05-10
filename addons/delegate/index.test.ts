import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import delegateAddon, { buildModelCandidates, delegateTaskPreview, modelSimilarityScore, parsePiListModelsOutput } from "./delegate.ts";

const addonDir = import.meta.dir;

describe("delegate addon", () => {
  test("exports an extension entrypoint", () => {
    expect(typeof delegateAddon).toBe("function");
  });

  test("delegate task previews are compact and single-line", () => {
    const preview = delegateTaskPreview("  Review\n\nthis long task and summarize the important findings for the user  ", 32);
    expect(preview).toBe("Review this long task and summa…");
  });

  test("delegate surfaces progress and timeline feedback guidance", () => {
    const source = readFileSync(resolve(addonDir, "delegate.ts"), "utf8");
    expect(source).toContain("setWorkingMessage");
    expect(source).toContain("setStatus?.(DELEGATE_STATUS_KEY");
    expect(source).toContain("clearDelegateProgress(ctx)");
    expect(source).toContain("visible one-sentence timeline update");
    expect(source).toContain("what you are delegating");
  });

  test("parses pi model list output", () => {
    const models = parsePiListModelsOutput(`provider        model              context  max-out  thinking  images
openai-codex    gpt-5.4-mini       272K     128K     yes       yes
anthropic       claude-sonnet-4.6  200K     32K      yes       yes
`);
    expect(models).toEqual([
      { provider: "openai-codex", id: "gpt-5.4-mini", fullId: "openai-codex/gpt-5.4-mini", context: "272K", maxOut: "128K", thinking: "yes", images: "yes" },
      { provider: "anthropic", id: "claude-sonnet-4.6", fullId: "anthropic/claude-sonnet-4.6", context: "200K", maxOut: "32K", thinking: "yes", images: "yes" },
    ]);
  });

  test("model matching picks up close direct-provider equivalents and excludes azure providers", () => {
    const models = [
      { provider: "github-copilot", id: "gpt-5.4-mini", fullId: "github-copilot/gpt-5.4-mini" },
      { provider: "openai", id: "gpt-5.4-mini", fullId: "openai/gpt-5.4-mini" },
      { provider: "anthropic", id: "claude-sonnet-4.6", fullId: "anthropic/claude-sonnet-4.6" },
      { provider: "azure-openai", id: "gpt-5.4-mini", fullId: "azure-openai/gpt-5.4-mini" },
    ];
    const candidates = buildModelCandidates(models, { searchable_providers: null });
    expect(candidates.some((candidate) => candidate.id === "openai/gpt-5.4-mini" && candidate.tier === 2)).toBe(true);
    expect(candidates.some((candidate) => candidate.id === "anthropic/claude-sonnet-4.6" && candidate.tier === 3)).toBe(true);
    expect(candidates.some((candidate) => candidate.provider.startsWith("azure-"))).toBe(false);
  });

  test("provider toggles constrain model matching", () => {
    const models = [
      { provider: "github-copilot", id: "gpt-5.4-mini", fullId: "github-copilot/gpt-5.4-mini" },
      { provider: "openai", id: "gpt-5.4-mini", fullId: "openai/gpt-5.4-mini" },
      { provider: "anthropic", id: "claude-sonnet-4.6", fullId: "anthropic/claude-sonnet-4.6" },
    ];
    const candidates = buildModelCandidates(models, { searchable_providers: ["anthropic"] });
    expect(candidates.every((candidate) => candidate.provider === "anthropic")).toBe(true);
    expect(candidates.some((candidate) => candidate.id === "anthropic/claude-sonnet-4.6")).toBe(true);
    expect(buildModelCandidates(models, { searchable_providers: [] })).toEqual([]);
  });

  test("close matching does not cross major model variants", () => {
    expect(modelSimilarityScore("gpt-5.4-mini", "gpt-5.4-mini")).toBe(100);
    const candidates = buildModelCandidates([
      { provider: "openai", id: "gpt-5.4", fullId: "openai/gpt-5.4" },
    ], { searchable_providers: null });
    expect(candidates.some((candidate) => candidate.sourceId === "github-copilot/gpt-5.4-mini")).toBe(false);
    expect(candidates.some((candidate) => candidate.sourceId === "github-copilot/gpt-5.4")).toBe(true);
  });

  test("delegate settings pane exposes provider checkboxes and model refresh", () => {
    const source = readFileSync(resolve(addonDir, "web/index.ts"), "utf8");
    expect(source).toContain("type=\"checkbox\"");
    expect(source).toContain("Filter providers");
    expect(source).toContain("Refresh");
    expect(source).toContain("models");
  });

  test("delegate manifest declares typebox for runtime and compatibility", () => {
    const manifest = JSON.parse(readFileSync(resolve(addonDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.["@sinclair/typebox"]).toBe("*");
    expect(manifest.peerDependencies?.["@sinclair/typebox"]).toBe("*");
    expect(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("*");
  });
});
