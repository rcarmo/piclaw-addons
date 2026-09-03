import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hasAdapterTools,
  mergeAdapterTools,
  restoreTools,
} from "./src/adapter/tool-set.ts";
import {
  applyGitHubCopilotInferenceProfile,
  GITHUB_COPILOT_INFERENCE_PROFILE,
  isGitHubCopilotInferenceProfileStale,
  resolveAdapterProfile,
} from "./src/adapter/provider-profile.ts";
import { isCodexLikeModel } from "./src/adapter/codex-model.ts";
import { setAdapterStatus } from "./src/adapter/ui-status.ts";
import { syncAdapterTools } from "./src/adapter/profile-controller.ts";
import { rewriteNativeWebSearchTool, supportsNativeWebSearch } from "./src/tools/web-search-tool.ts";
import {
  parseResponsesSSE,
  registerOpenAICodexNativeOutputObserver,
  requiresNativeOutputCapture,
} from "./src/providers/openai-codex-native-output-observer.ts";
import codexConversion from "./src/index.ts";

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

function model(provider: string, id: string, api = "openai-responses", input: string[] = ["text"]) {
  return { provider, id, api, input } as any;
}

function createContext(mode: "tui" | "rpc" | "json" | "print", selectedModel: any, statuses: Array<[string, string | undefined]>) {
  return {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/workspace",
    model: selectedModel,
    getSystemPrompt: () => "Guidelines:\n- Existing\n\nCurrent date: 2026-09-03",
    ui: {
      setStatus(key: string, text: string | undefined) { statuses.push([key, text]); },
      theme: { fg: (_role: string, text: string) => `<accent>${text}</accent>` },
    },
  } as any;
}

test("package keeps upstream attribution and runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(join(addonDir, "package.json"), "utf8"));
  expect(manifest.name).toBe("@rcarmo/piclaw-addon-codex-conversion");
  expect(manifest.pi.extensions).toEqual(["src/index.ts"]);
  expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
  expect(manifest.peerDependencies["@earendil-works/pi-ai"]).toBe("*");
  expect(manifest.peerDependencies["@earendil-works/pi-tui"]).toBe("*");
  expect(manifest.peerDependencies["@sinclair/typebox"]).toBe("*");
  expect(manifest.dependencies["node-gyp"]).toBeUndefined();
  expect(manifest.dependencies["node-pty"]).toBeUndefined();
  expect(manifest.dependencies["partial-json"]).toBeUndefined();
  expect(manifest.dependencies["tree-sitter-bash"]).toBeTruthy();
  expect(manifest.dependencies["web-tree-sitter"]).toBeTruthy();
  expect(readFileSync(join(addonDir, "LICENSE.upstream"), "utf8")).toContain("MIT License");
  expect(readFileSync(join(addonDir, "README.md"), "utf8")).toContain("IgorWarzocha/pi-codex-conversion");
});

test("source imports current package names and keeps one provider observer overlay", () => {
  const files = collectTsFiles(join(addonDir, "src"));
  const combined = files.map((file) => readFileSync(file, "utf8")).join("\n");
  expect(files.length).toBeGreaterThan(10);
  expect(combined).not.toContain("@mariozechner/");
  expect(combined).not.toContain('from "typebox"');
  expect(combined.match(/registerProvider\("openai-codex"/g)).toHaveLength(1);
  expect(combined).toContain("requiresNativeOutputCapture(context)");
  expect(combined).toContain("streamBuiltin ?? streamBuiltinProvider");
  expect(combined).not.toContain("createCodexStream");
  expect(combined).not.toContain("processResponsesStream");
  expect(combined).not.toContain("new WebSocket");
  expect(combined).toContain("@earendil-works/pi-coding-agent");
  expect(combined).toContain("@earendil-works/pi-ai");
  expect(combined).toContain("@earendil-works/pi-tui");
  expect(combined).toContain("@sinclair/typebox");
});

test("resolves explicit provider-aware adapter profiles", () => {
  expect(resolveAdapterProfile(model("openai-codex", "gpt-5.6-sol", "openai-codex-responses"))).toBe("codex-tools");
  expect(resolveAdapterProfile(model("github-copilot", "gpt-5.6-sol"))).toBe("copilot-tools");
  expect(resolveAdapterProfile(model("github-copilot", "claude-opus-5", "anthropic-messages"))).toBe("native");
  expect(resolveAdapterProfile(model("openai", "gpt-5.6-sol"))).toBe("native");
  expect(resolveAdapterProfile(model("openrouter", "openai/gpt-5.6-sol"))).toBe("native");
  expect(resolveAdapterProfile(model("other", "custom-codex"))).toBe("native");
  expect(resolveAdapterProfile(model("other", "custom", "openai-codex-responses"))).toBe("codex-tools");
  expect(resolveAdapterProfile(null)).toBe("native");
  expect(isCodexLikeModel(model("github-copilot", "gpt-5.6-sol"))).toBe(true);
  expect(isCodexLikeModel(model("openai", "gpt-5.6-sol"))).toBe(false);
});

test("GitHub Copilot inference profile overrides identity and preserves dynamic headers", () => {
  const headers: Record<string, string | null> = {
    authorization: "Bearer secret",
    "user-agent": "pi",
    "Editor-Version": "vscode/old",
    "Editor-Plugin-Version": "copilot-chat/old",
    "Copilot-Integration-Id": "vscode-chat",
    "X-Initiator": "agent",
    "Openai-Intent": "conversation-edits",
    "Copilot-Vision-Request": "true",
    "x-request-id": "request-1",
  };
  expect(applyGitHubCopilotInferenceProfile(headers, model("github-copilot", "gpt-5.6-sol"))).toBe(true);
  expect(headers).toMatchObject({
    authorization: "Bearer secret",
    "User-Agent": GITHUB_COPILOT_INFERENCE_PROFILE.userAgent,
    "Editor-Version": GITHUB_COPILOT_INFERENCE_PROFILE.editorVersion,
    "Editor-Plugin-Version": GITHUB_COPILOT_INFERENCE_PROFILE.editorPluginVersion,
    "Copilot-Integration-Id": "vscode-chat",
    "X-Initiator": "agent",
    "Openai-Intent": "conversation-edits",
    "Copilot-Vision-Request": "true",
    "x-request-id": "request-1",
  });
  expect(headers["user-agent"]).toBeUndefined();
});

test("GitHub Copilot profile preserves an upstream integration id", () => {
  const headers = { "Copilot-Integration-Id": "future-integration" };
  applyGitHubCopilotInferenceProfile(headers, model("github-copilot", "gpt-5.6-sol"));
  expect(headers["Copilot-Integration-Id"]).toBe("future-integration");
});

test("GitHub Copilot compatibility profile has an offline staleness check", () => {
  expect(GITHUB_COPILOT_INFERENCE_PROFILE.reviewedAt).toBe("2026-09-03");
  expect(isGitHubCopilotInferenceProfileStale(new Date("2026-12-01T00:00:00Z"))).toBe(false);
  expect(isGitHubCopilotInferenceProfileStale(new Date("2026-12-03T00:00:01Z"))).toBe(true);
});

test("header profile leaves non-Copilot requests unchanged", () => {
  const headers = { "User-Agent": "pi", Authorization: "Bearer secret" };
  const before = structuredClone(headers);
  expect(applyGitHubCopilotInferenceProfile(headers, model("openai-codex", "gpt-5.5"))).toBe(false);
  expect(headers).toEqual(before);
});

test("native web search declaration is scoped to OpenAI Codex", () => {
  const codex = model("openai-codex", "gpt-5.5", "openai-codex-responses");
  expect(supportsNativeWebSearch(codex)).toBe(true);
  expect(supportsNativeWebSearch(model("github-copilot", "gpt-5.6-sol"))).toBe(false);
  const payload = { tools: [{ type: "function", name: "web_search", parameters: {} }, { type: "function", name: "exec_command", parameters: {} }] };
  expect(rewriteNativeWebSearchTool(payload, codex)).toEqual({
    tools: [
      { type: "web_search", external_web_access: true, search_content_types: ["text", "image"] },
      { type: "function", name: "exec_command", parameters: {} },
    ],
    include: ["web_search_call.action.sources", "web_search_call.results"],
  });
  expect(rewriteNativeWebSearchTool({ ...payload, include: ["message.output_text.logprobs", "web_search_call.results"] }, codex)).toMatchObject({
    include: ["message.output_text.logprobs", "web_search_call.results", "web_search_call.action.sources"],
  });
  expect(rewriteNativeWebSearchTool(payload, model("github-copilot", "gpt-5.6-sol"))).toBe(payload);
});

test("provider overlay delegates all requests and only observes native output turns", () => {
  expect(requiresNativeOutputCapture({ tools: [] })).toBe(false);
  expect(requiresNativeOutputCapture({ tools: [{ name: "exec_command" } as any] })).toBe(false);
  expect(requiresNativeOutputCapture({ tools: [{ name: "web_search" } as any] })).toBe(true);
  expect(requiresNativeOutputCapture({ tools: [{ name: "image_generation" } as any] })).toBe(true);

  const providers: Array<{ id: string; config: any }> = [];
  const builtinStream = { delegated: true } as any;
  const calls: any[][] = [];
  const streamBuiltin = ((...args: any[]) => {
    calls.push(args);
    return builtinStream;
  }) as any;
  registerOpenAICodexNativeOutputObserver({
    registerProvider(id: string, config: any) { providers.push({ id, config }); },
    on() {}, registerMessageRenderer() {}, sendMessage() {},
  } as any, { getCurrentCwd: () => "/workspace", streamBuiltin });

  expect(providers).toHaveLength(1);
  expect(providers[0]?.id).toBe("openai-codex");
  expect(Object.keys(providers[0]!.config).sort()).toEqual(["api", "streamSimple"]);
  const modelValue = model("openai-codex", "gpt-5.5", "openai-codex-responses");
  expect(providers[0]!.config.streamSimple(
    modelValue,
    { messages: [], tools: [{ name: "exec_command" }] },
    { sessionId: "ordinary" },
  )).toBe(builtinStream);
  expect(providers[0]!.config.streamSimple(
    modelValue,
    { messages: [], tools: [{ name: "web_search" }] },
    { sessionId: "native", transport: "websocket" },
  )).toBe(builtinStream);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[2]).toEqual({ sessionId: "ordinary" });
  expect(calls[1]?.[2]).toMatchObject({ sessionId: "native", transport: "sse" });
  expect(typeof calls[1]?.[2]?.fetch).toBe("function");
});

test("native-output observer saves images and emits search activity through pi-ai's fetch path", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-native-output-"));
  const providers: Array<{ id: string; config: any }> = [];
  const handlers = new Map<string, Function[]>();
  const sent: any[] = [];
  const body = [
    'data: {"type":"response.created","response":{"id":"resp_1"}}',
    "",
    `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", id: "image_1", result: Buffer.from("test-image").toString("base64"), output_format: "png", revised_prompt: "A dot" } })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "web_search_call", id: "search_1", action: { query: "dot", sources: [{ url: "https://example.com/a" }] }, results: [{ title: "Dot", url: "https://example.com/a" }] } })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  let delegatedOptions: any;
  const streamBuiltin = ((_model: any, _context: any, options: any) => {
    delegatedOptions = options;
    return { delegated: true } as any;
  }) as any;
  registerOpenAICodexNativeOutputObserver({
    registerProvider(id: string, config: any) { providers.push({ id, config }); },
    on(event: string, handler: Function) { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
    registerMessageRenderer() {},
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
  } as any, { getCurrentCwd: () => root, streamBuiltin });

  try {
    providers[0]!.config.streamSimple(
      model("openai-codex", "gpt-5.5", "openai-codex-responses", ["text", "image"]),
      { messages: [{ role: "user", content: "Draw a dot" }], tools: [{ name: "image_generation" }, { name: "web_search" }] },
      { fetch: async () => new Response(body, { status: 200 }) },
    );
    const response = await delegatedOptions.fetch("https://example.invalid/codex/responses", { method: "POST" });
    expect(response.ok).toBe(true);
    await handlers.get("agent_end")?.[0]?.({ type: "agent_end" }, {});

    expect(delegatedOptions.transport).toBe("sse");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.message.customType).toBe("codex-image-generation-display");
    expect(sent[1]?.message.customType).toBe("codex-web-search-activity");
    expect(sent[1]?.message.content).toContain("Dot — https://example.com/a");
    const imagePath = sent[0]?.message.details.savedImages[0].absolutePath;
    expect(readFileSync(imagePath, "utf8")).toBe("test-image");
    expect(existsSync(join(root, ".pi/openai-codex-images/latest.png"))).toBe(true);
    expect(sent.every((entry) => entry.options.triggerTurn === false)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("SSE observer parses LF and CRLF events without owning protocol errors", () => {
  const events = parseResponsesSSE([
    'data: {"type":"response.created","response":{"id":"resp_1"}}',
    "",
    'data: {"type":"response.output_item.done",',
    'data: "item":{"type":"web_search_call","id":"search_1"}}',
    "",
    "data: not-json",
    "",
    "data: [DONE]",
    "",
  ].join("\r\n"));
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ type: "response.created", response: { id: "resp_1" } });
  expect(events[1]).toMatchObject({ type: "response.output_item.done", item: { type: "web_search_call", id: "search_1" } });
});

test("status labels are TUI-only and theme-derived", () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const statuses: Array<[string, string | undefined]> = [];
    setAdapterStatus(createContext(mode, model("github-copilot", "gpt-5.6-sol"), statuses), "copilot-tools");
    expect(statuses).toEqual([]);
  }

  const statuses: Array<[string, string | undefined]> = [];
  const ctx = createContext("tui", model("openai-codex", "gpt-5.5", "openai-codex-responses"), statuses);
  setAdapterStatus(ctx, "codex-tools");
  setAdapterStatus(ctx, "copilot-tools");
  setAdapterStatus(ctx, "native");
  expect(statuses).toEqual([
    ["codex-adapter", "<accent>Codex tools</accent>"],
    ["codex-adapter", "<accent>Copilot tools</accent>"],
    ["codex-adapter", undefined],
  ]);
  expect(JSON.stringify(statuses)).not.toContain("\\u001b");
});

test("profile controller activates, relabels, and restores tools across lifecycle modes", () => {
  let activeTools = ["read", "bash", "edit", "write", "messages"];
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
  } as any;
  const state = { profile: "native" as const, previousToolNames: undefined as string[] | undefined };
  const rpcStatuses: Array<[string, string | undefined]> = [];
  expect(syncAdapterTools(
    pi,
    createContext("rpc", model("github-copilot", "gpt-5.6-sol"), rpcStatuses),
    state,
    ["exec_command", "write_stdin", "apply_patch"],
  )).toBe("copilot-tools");
  expect(rpcStatuses).toEqual([]);
  expect(activeTools).toEqual(["exec_command", "write_stdin", "apply_patch", "messages"]);

  const tuiStatuses: Array<[string, string | undefined]> = [];
  expect(syncAdapterTools(
    pi,
    createContext("tui", model("openai-codex", "gpt-5.5", "openai-codex-responses"), tuiStatuses),
    state,
    ["exec_command", "write_stdin", "apply_patch", "web_search"],
  )).toBe("codex-tools");
  expect(tuiStatuses).toEqual([["codex-adapter", "<accent>Codex tools</accent>"]]);
  expect(activeTools).toEqual(["exec_command", "write_stdin", "apply_patch", "web_search", "messages"]);

  expect(syncAdapterTools(
    pi,
    createContext("tui", model("anthropic", "claude-opus-5", "anthropic-messages"), tuiStatuses),
    state,
    [],
  )).toBe("native");
  expect(tuiStatuses.at(-1)).toEqual(["codex-adapter", undefined]);
  expect(activeTools).toEqual(["read", "bash", "edit", "write", "messages"]);
});

test("tool merging, detection, and restoration preserve unrelated extension tools", () => {
  expect(hasAdapterTools(["read", "messages"])).toBe(false);
  expect(hasAdapterTools(["read", "exec_command"])).toBe(true);
  expect(mergeAdapterTools(["read", "bash", "messages"], ["exec_command", "write_stdin", "apply_patch"]))
    .toEqual(["exec_command", "write_stdin", "apply_patch", "messages"]);
  expect(restoreTools(["read", "bash", "messages"], ["exec_command", "write_stdin", "apply_patch", "proxmox"]))
    .toEqual(["read", "bash", "messages", "proxmox"]);
  expect(mergeAdapterTools(
    ["read", "bash", "web_search", "image_generation", "messages"],
    ["exec_command", "write_stdin", "apply_patch"],
  )).toEqual(["exec_command", "write_stdin", "apply_patch", "web_search", "image_generation", "messages"]);
  expect(restoreTools(
    ["read", "bash", "messages"],
    ["exec_command", "write_stdin", "apply_patch", "web_search", "image_generation"],
  )).toEqual(["read", "bash", "messages"]);
  expect(restoreTools(
    ["read", "bash", "web_search", "messages"],
    ["exec_command", "write_stdin", "apply_patch", "web_search", "image_generation"],
  )).toEqual(["read", "bash", "web_search", "messages"]);
});

test("profile controller restores an intentionally empty tool set", () => {
  let activeTools: string[] = [];
  const pi = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
  } as any;
  const state = { profile: "native" as const, previousToolNames: undefined as string[] | undefined };
  syncAdapterTools(
    pi,
    createContext("rpc", model("openai-codex", "gpt-5.5", "openai-codex-responses"), []),
    state,
    ["exec_command", "write_stdin", "apply_patch"],
  );
  syncAdapterTools(
    pi,
    createContext("rpc", model("anthropic", "claude-opus-5", "anthropic-messages"), []),
    state,
    [],
  );
  expect(activeTools).toEqual([]);
});

test("registered lifecycle handlers never emit status outside TUI", async () => {
  const handlers = new Map<string, Function[]>();
  let activeTools = ["read", "bash", "edit", "write", "messages"];
  const pi = {
    on(event: string, handler: Function) { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
    registerProvider() {}, registerTool() {}, registerMessageRenderer() {}, sendMessage() {},
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) { activeTools = [...names]; },
  } as any;
  codexConversion(pi);

  expect(handlers.get("session_start")).toHaveLength(2);
  expect(handlers.get("model_select")).toHaveLength(1);
  expect(handlers.get("before_provider_headers")).toHaveLength(1);
  for (const mode of ["rpc", "json", "print"] as const) {
    const statuses: Array<[string, string | undefined]> = [];
    const ctx = createContext(mode, model("github-copilot", "gpt-5.6-sol"), statuses);
    for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
    for (const handler of handlers.get("model_select") ?? []) await handler({ type: "model_select" }, ctx);
    expect(statuses).toEqual([]);
  }
});

test("registered handlers apply TUI status and provider-scoped headers", async () => {
  const handlers = new Map<string, Function[]>();
  const statuses: Array<[string, string | undefined]> = [];
  let activeTools = ["read", "bash", "edit", "write"];
  const pi = {
    on(event: string, handler: Function) { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
    registerProvider() {}, registerTool() {}, registerMessageRenderer() {}, sendMessage() {},
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) { activeTools = [...names]; },
  } as any;
  codexConversion(pi);

  const copilot = model("github-copilot", "gpt-5.6-sol");
  const tui = createContext("tui", copilot, statuses);
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, tui);
  expect(statuses).toContainEqual(["codex-adapter", "<accent>Copilot tools</accent>"]);

  const copilotHeaders: Record<string, string | null> = {
    "User-Agent": "old",
    "Editor-Version": "old",
    "Editor-Plugin-Version": "old",
    "Copilot-Integration-Id": "vscode-chat",
    "X-Initiator": "agent",
  };
  await handlers.get("before_provider_headers")?.[0]?.(
    { type: "before_provider_headers", headers: copilotHeaders },
    tui,
  );
  expect(copilotHeaders).toMatchObject({
    "User-Agent": GITHUB_COPILOT_INFERENCE_PROFILE.userAgent,
    "Editor-Version": GITHUB_COPILOT_INFERENCE_PROFILE.editorVersion,
    "Editor-Plugin-Version": GITHUB_COPILOT_INFERENCE_PROFILE.editorPluginVersion,
    "Copilot-Integration-Id": "vscode-chat",
    "X-Initiator": "agent",
  });

  const nativeHeaders = { "User-Agent": "pi", "x-request-id": "request-2" };
  const before = structuredClone(nativeHeaders);
  await handlers.get("before_provider_headers")?.[0]?.(
    { type: "before_provider_headers", headers: nativeHeaders },
    createContext("rpc", model("openai", "gpt-5.5"), []),
  );
  expect(nativeHeaders).toEqual(before);
});
