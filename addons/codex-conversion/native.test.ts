import { describe, expect, test } from "bun:test";
import { createNativeCodexHooks } from "./src/native.ts";
import { resolveAdapterProfile, applyGitHubCopilotInferenceProfile } from "./src/adapter/provider-profile.ts";
import { rewriteNativeImageGenerationTool } from "./src/tools/image-generation-tool.ts";
import { rewriteNativeWebSearchTool } from "./src/tools/web-search-tool.ts";

describe("pure native Codex hooks", () => {
  for (const model of [undefined, { provider: "openai-codex", id: "gpt", input: ["image"] }, { provider: "openai-codex", id: "spark" }, { provider: "github-copilot", id: "gpt-5" }, { provider: "other", api: "openai-codex-responses" }]) {
    test(`profile/request/header parity ${JSON.stringify(model)}`, () => {
      const hooks = createNativeCodexHooks(model);
      expect(hooks.profile).toBe(resolveAdapterProfile(model));
      const payload = { tools: [{ type: "function", name: "web_search" }, { type: "function", name: "image_generation" }], include: ["other"] };
      const before = JSON.stringify(payload);
      expect(hooks.request(payload)).toEqual(rewriteNativeImageGenerationTool(rewriteNativeWebSearchTool(payload, model as any), model as any));
      expect(JSON.stringify(payload)).toBe(before);
      const headers = { "user-agent": "original" };
      const expected = { ...headers };
      applyGitHubCopilotInferenceProfile(expected, model as any);
      expect(hooks.headers(headers)).toEqual(expected);
      expect(headers).toEqual({ "user-agent": "original" });
    });
  }
  test("detached model and context; on-demand tools retained", () => {
    const model = { provider: "openai-codex", id: "gpt", input: ["image"] };
    const hooks = createNativeCodexHooks(model);
    model.provider = "other"; model.input.length = 0;
    expect(hooks.tools(["read", "web_search", "image_generation", "custom"])).toEqual(["exec_command", "write_stdin", "apply_patch", "view_image", "web_search", "image_generation", "custom"]);
    const messages = [{ role: "custom", customType: "codex-image-generation-display" }, { role: "user" }];
    expect(hooks.context(messages)).toEqual([{ role: "user" }]);
    expect(messages.length).toBe(2);
    expect(hooks.systemPrompt("Hello", "sh")).toContain("apply_patch");
    expect(createNativeCodexHooks(undefined).systemPrompt("Hello")).toBe("Hello");
  });
});

test("view image declaration follows the detached source model, not registry inventory", () => {
  const model = { provider: "openai-codex", api: "openai-codex-responses", input: ["text", "image"] };
  const hooks = createNativeCodexHooks(model);
  model.provider = "other"; model.input.length = 0;
  const inventory = [{ name: "view_image", parameters: { properties: {} as Record<string, unknown> } }, { name: "custom", parameters: { properties: {} as Record<string, unknown> } }];
  expect(hooks.toolDeclarations(inventory)[0]!.parameters.properties.detail).toBeDefined();
  const copilot = createNativeCodexHooks({ provider: "github-copilot", id: "gpt-5", input: ["text", "image"] });
  expect(copilot.toolDeclarations(inventory)[0]!.parameters.properties.detail).toBeUndefined();
  expect(hooks.toolDeclarations(inventory)[1]).toBe(inventory[1]);
  expect(inventory[0]!.parameters.properties.detail).toBeUndefined();
  expect(createNativeCodexHooks({ provider: "other", input: ["text"] }).tools(["view_image", "custom"])).toEqual(["custom"]);
});

test("native provider shapes are explicit and Spark excludes multimodal search", () => {
  const payload = { tools: [{ type: "function", name: "web_search" }, { type: "function", name: "image_generation" }] };
  expect(createNativeCodexHooks({ provider: "openai-codex", input: ["image"] }).request(payload)).toEqual({
    tools: [{ type: "web_search", external_web_access: true, search_content_types: ["text", "image"] }, { type: "image_generation", output_format: "png" }],
    include: ["web_search_call.action.sources", "web_search_call.results"],
  });
  expect(createNativeCodexHooks({ provider: "openai-codex", id: "spark" }).request(payload)).toEqual({
    tools: [{ type: "web_search", external_web_access: true }, payload.tools[1]],
    include: ["web_search_call.action.sources", "web_search_call.results"],
  });
});
