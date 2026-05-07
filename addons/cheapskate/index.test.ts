import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import cheapskate, { BACKENDS, currentBackendId, resetCheapskateForTests } from "./index.ts";

type ProviderRegistration = { name: string; config: any };

const ENV_KEYS = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "SAMBANOVA_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  "NVIDIA_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
];

const savedEnv = new Map<string, string | undefined>();
const savedGlobals = {
  runtimeInterop: (globalThis as any).__piclawRuntimeInterop,
  addonConfigApi: (globalThis as any).__piclaw_registerAddonConfigApi,
};

for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  resetCheapskateForTests();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  if (savedGlobals.runtimeInterop === undefined) delete (globalThis as any).__piclawRuntimeInterop;
  else (globalThis as any).__piclawRuntimeInterop = savedGlobals.runtimeInterop;

  if (savedGlobals.addonConfigApi === undefined) delete (globalThis as any).__piclaw_registerAddonConfigApi;
  else (globalThis as any).__piclaw_registerAddonConfigApi = savedGlobals.addonConfigApi;
});

function createHarness() {
  const providers: ProviderRegistration[] = [];
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => any>();

  const api = {
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
    registerProvider(name: string, config: any) { providers.push({ name, config }); },
    unregisterProvider() {},
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag() { return undefined; },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName() { return undefined; },
    setLabel() {},
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "off",
    setThinkingLevel() {},
  } as any;

  return { api, providers, tools, handlers };
}

function getActiveModel(registrations: ProviderRegistration[]) {
  const latest = registrations.at(-1);
  expect(latest?.name).toBe("cheapskate");
  return latest!.config.models[0];
}

const addonDir = import.meta.dir;

describe("cheapskate addon", () => {
  test("exposes OpenCode Zen and NVIDIA free backends", () => {
    const opencode = BACKENDS.find((backend) => backend.id === "opencode");
    const nvidia = BACKENDS.find((backend) => backend.id === "nvidia");

    expect(opencode?.apiKeyEnv).toBe("OPENCODE_API_KEY");
    expect(opencode?.baseUrl).toBe("https://api.opencode.ai/v1");
    expect(opencode?.modelId).toBe("openai/gpt-oss-120b");

    expect(nvidia?.apiKeyEnv).toBe("NVIDIA_API_KEY");
    expect(nvidia?.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(nvidia?.modelId).toBe("meta/llama-3.3-70b-instruct");
  });

  test("settings pane lists OpenCode Zen and NVIDIA keychain entries", () => {
    const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
    expect(source).toContain("opencode/api-key");
    expect(source).toContain("nvidia/api-key");
  });

  test("registers in a vanilla runtime without piclaw globals", async () => {
    delete (globalThis as any).__piclawRuntimeInterop;
    delete (globalThis as any).__piclaw_registerAddonConfigApi;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key";

    const { api, providers, tools } = createHarness();
    cheapskate(api);

    expect(providers).toHaveLength(1);
    expect(tools.has("cheapskate")).toBe(true);

    const model = getActiveModel(providers);
    const google = BACKENDS.find((backend) => backend.id === "google")!;
    expect(model.compat.modelId).toBe(google.modelId);
    expect(model.contextWindow).toBe(google.contextWindow);
    expect(model.maxTokens).toBe(google.maxTokens);
    expect(model.reasoning).toBe(google.reasoning);

    const status = await tools.get("cheapskate").execute("call-1", { action: "status" });
    expect(status.details).toEqual({ configured: 1, available: 1, active: "google" });
  });

  test("reports the active backend model limits instead of the largest configured backend", async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key";
    process.env.GROQ_API_KEY = "test-groq-key";

    const { api, providers, tools } = createHarness();
    cheapskate(api);

    const google = BACKENDS.find((backend) => backend.id === "google")!;
    const groq = BACKENDS.find((backend) => backend.id === "groq")!;

    let model = getActiveModel(providers);
    expect(model.compat.modelId).toBe(google.modelId);
    expect(model.contextWindow).toBe(google.contextWindow);
    expect(model.maxTokens).toBe(google.maxTokens);
    expect(currentBackendId).toBe("google");

    await tools.get("cheapskate").execute("call-2", { action: "rotate" });

    model = getActiveModel(providers);
    expect(model.compat.modelId).toBe(groq.modelId);
    expect(model.contextWindow).toBe(groq.contextWindow);
    expect(model.maxTokens).toBe(groq.maxTokens);
    expect(model.reasoning).toBe(groq.reasoning);
    expect(currentBackendId).toBe("groq");
  });

  test("context-limit errors rotate toward a backend with a larger window when available", async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key";
    process.env.GROQ_API_KEY = "test-groq-key";

    const { api, providers, tools, handlers } = createHarness();
    cheapskate(api);

    await tools.get("cheapskate").execute("call-3", { action: "rotate" });
    expect(currentBackendId).toBe("groq");

    const afterProviderResponse = handlers.get("after_provider_response");
    expect(typeof afterProviderResponse).toBe("function");

    await afterProviderResponse?.({
      model: { provider: "cheapskate", id: "auto" },
      status: 400,
      error: "Context window exceeded for this model.",
    });

    const model = getActiveModel(providers);
    const google = BACKENDS.find((backend) => backend.id === "google")!;
    expect(model.compat.modelId).toBe(google.modelId);
    expect(model.contextWindow).toBe(google.contextWindow);
    expect(currentBackendId).toBe("google");
  });
});
