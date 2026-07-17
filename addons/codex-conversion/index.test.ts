import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  buildRequestBody,
  buildSSEHeaders,
  buildWebSocketHeaders,
  clampCodexSessionId,
  mergeCodexHeaders,
  registerOpenAICodexCustomProvider,
} from "./src/providers/openai-codex-custom-provider.ts";

const addonDir = import.meta.dir;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("codex-conversion package keeps upstream attribution and runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(join(addonDir, "package.json"), "utf8"));

  expect(manifest.name).toBe("@rcarmo/piclaw-addon-codex-conversion");
  expect(manifest.pi.extensions).toEqual(["src/index.ts"]);
  expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
  expect(manifest.peerDependencies["@earendil-works/pi-ai"]).toBe("*");
  expect(manifest.peerDependencies["@earendil-works/pi-tui"]).toBe("*");
  expect(manifest.peerDependencies["@sinclair/typebox"]).toBe("*");
  expect(manifest.dependencies["node-pty"]).toBeTruthy();
  expect(manifest.dependencies["partial-json"]).toBeTruthy();
  expect(manifest.dependencies["tree-sitter-bash"]).toBeTruthy();
  expect(manifest.dependencies["web-tree-sitter"]).toBeTruthy();

  expect(readFileSync(join(addonDir, "LICENSE.upstream"), "utf8")).toContain("MIT License");
  expect(readFileSync(join(addonDir, "README.md"), "utf8")).toContain("IgorWarzocha/pi-codex-conversion");
});

test("codex-conversion source imports target Piclaw package names", () => {
  const files = collectTsFiles(join(addonDir, "src"));
  expect(files.length).toBeGreaterThan(10);
  const combined = files.map((file) => readFileSync(file, "utf8")).join("\n");

  expect(combined).not.toContain("@mariozechner/");
  expect(combined).not.toContain('from "typebox"');
  expect(combined).toContain("@earendil-works/pi-coding-agent");
  expect(combined).toContain("@earendil-works/pi-ai");
  expect(combined).toContain("@earendil-works/pi-tui");
  expect(combined).toContain("@sinclair/typebox");
});

test("registers only a partial stream overlay so built-in OAuth and catalog remain inherited", () => {
  const providers: Array<{ id: string; config: Record<string, unknown> }> = [];
  const handlers = new Map<string, Function>();
  const api = {
    registerProvider(id: string, config: Record<string, unknown>) { providers.push({ id, config }); },
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerMessageRenderer() {},
    sendMessage() {},
  } as any;

  registerOpenAICodexCustomProvider(api, { getCurrentCwd: () => "/workspace" });

  expect(providers).toHaveLength(1);
  expect(providers[0]?.id).toBe("openai-codex");
  expect(Object.keys(providers[0]!.config).sort()).toEqual(["api", "streamSimple"]);
  expect(providers[0]!.config.api).toBe("openai-codex-responses");
  expect(typeof providers[0]!.config.streamSimple).toBe("function");
  expect(providers[0]!.config).not.toHaveProperty("oauth");
  expect(providers[0]!.config).not.toHaveProperty("models");
  expect(providers[0]!.config).not.toHaveProperty("baseUrl");
  expect(providers[0]!.config).not.toHaveProperty("apiKey");
  expect(handlers.has("session_shutdown")).toBe(true);
});

test("nullable request headers delete inherited defaults", () => {
  const headers = mergeCodexHeaders(
    { "x-keep": "model", "x-delete": "model", authorization: "stale" },
    { "x-keep": "request", "x-delete": null, authorization: null },
  );

  expect(headers.get("x-keep")).toBe("request");
  expect(headers.has("x-delete")).toBe(false);
  expect(headers.has("authorization")).toBe(false);
});

test("clamps protocol-visible Codex session IDs and uses upstream header names", () => {
  const longId = `${"a".repeat(62)}😀😀😀`;
  const clamped = clampCodexSessionId(longId)!;
  expect(Array.from(clamped)).toHaveLength(64);
  expect(clamped).toBe(`${"a".repeat(62)}😀😀`);

  const asciiSessionId = clampCodexSessionId("session-".repeat(12))!;
  expect(asciiSessionId).toHaveLength(64);
  const sseHeaders = buildSSEHeaders({}, {}, "account", "token", asciiSessionId);
  expect(sseHeaders.get("session-id")).toBe(asciiSessionId);
  expect(sseHeaders.get("x-client-request-id")).toBe(asciiSessionId);
  expect(sseHeaders.has("session_id")).toBe(false);

  const websocketHeaders = buildWebSocketHeaders({}, {}, "account", "token", asciiSessionId);
  expect(websocketHeaders.get("session-id")).toBe(asciiSessionId);
  expect(websocketHeaders.get("x-client-request-id")).toBe(asciiSessionId);
  expect(websocketHeaders.has("session_id")).toBe(false);

  const body = buildRequestBody({
    provider: "openai-codex",
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-codex-responses",
    baseUrl: "https://credential-specific.example/backend-api",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  } as any, { systemPrompt: "test", messages: [] }, { sessionId: longId });
  expect(body.prompt_cache_key).toBe(clamped);
});

test("serializes newly activated deferred tools at the activating result position", () => {
  const activateTool = { name: "activate_tools", description: "activate", parameters: { type: "object" } } as any;
  const targetTool = { name: "target_tool", description: "target", parameters: { type: "object" } } as any;
  const model = {
    provider: "openai-codex",
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
    compat: { supportsToolSearch: true },
  } as any;
  const body = buildRequestBody(model, {
    systemPrompt: "test",
    tools: [activateTool, targetTool],
    messages: [
      {
        role: "assistant",
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.4",
        content: [{ type: "toolCall", id: "call_activate|fc_activate", name: "activate_tools", arguments: {} }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call_activate|fc_activate",
        toolName: "activate_tools",
        content: [{ type: "text", text: "activated" }],
        addedToolNames: ["target_tool"],
        isError: false,
        timestamp: 2,
      },
    ],
  });

  expect(body.tools).toEqual([expect.objectContaining({ name: "activate_tools" })]);
  const loadIndex = body.input.findIndex((item: any) => item.type === "tool_search_output");
  const resultIndex = body.input.findIndex((item: any) => item.type === "function_call_output");
  expect(loadIndex).toBe(resultIndex + 2);
  expect((body.input[loadIndex] as any).tools).toEqual([
    expect.objectContaining({ name: "target_tool", defer_loading: true }),
  ]);
});
