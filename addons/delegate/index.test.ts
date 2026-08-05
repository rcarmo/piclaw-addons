import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import delegateAddon, { buildDelegateModelChain, buildDelegateStatusUpdate, buildModelCandidates, captureRuntimeCatalog, classifyDelegateFailure, classifyModel, delegateProcessFailure, delegateStatusModelHint, describeImageCapability, delegateTaskPreview, getCurrentTier, getDelegateWorkspaceRoot, getExecutableCatalog, inspectDelegateFile, invalidateExecutableCatalog, isProviderAuthError, isRetryableDelegateFailure, mergeExecutableRuntimeMetadata, parseDelegateJsonOutput, parsePiListModelsOutput, prepareDelegateFile, resolveDelegateCliCommand, runDelegateProcess, runtimeModelToAvailable, selectModel, validateExplicitDelegateModel } from "./delegate.ts";

const addonDir = dirname(fileURLToPath(import.meta.url));

describe("delegate addon", () => {
  test("exports an extension entrypoint", () => {
    expect(typeof delegateAddon).toBe("function");
  });

  test("compat storage avoids runtime source imports", () => {
    const source = readFileSync(resolve(addonDir, "compat", "extension-kv.ts"), "utf8");
    expect(source).not.toContain("require(");
    expect(source).not.toContain("piclaw/runtime/src");
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

  test("delegate status exposes model hint and prompt arguments", () => {
    const prompt = "  Summarize\n\nthis file and list the important decisions for Rui  ";
    expect(buildDelegateStatusUpdate("openai/gpt-5.4-mini", prompt)).toBe(
      "Delegate model: openai/gpt-5.4-mini\nArguments: Summarize this file and list the important decisions for Rui",
    );
    expect(delegateStatusModelHint({ model: "anthropic/claude-sonnet-4.6", prompt })).toBe("anthropic/claude-sonnet-4.6");
    expect(delegateStatusModelHint({ prompt }, { output_preview: buildDelegateStatusUpdate("openai/gpt-5.4-mini", prompt) })).toBe("openai/gpt-5.4-mini");
  });

  test("parses pi model list output", () => {
    const models = parsePiListModelsOutput(`provider        model              context  max-out  thinking  images
openai-codex    gpt-5.4-mini       272K     128K     yes       yes
anthropic       claude-sonnet-4.6  200K     32K      yes       yes
`);
    expect(models).toEqual([
      { provider: "openai-codex", id: "gpt-5.4-mini", fullId: "openai-codex/gpt-5.4-mini", context: "272K", maxOut: "128K", thinking: "yes", images: "yes", contextWindow: 272_000, maxOutputTokens: 128_000, reasoning: true, supportsImages: true, catalogSource: "cli" },
      { provider: "anthropic", id: "claude-sonnet-4.6", fullId: "anthropic/claude-sonnet-4.6", context: "200K", maxOut: "32K", thinking: "yes", images: "yes", contextWindow: 200_000, maxOutputTokens: 32_000, reasoning: true, supportsImages: true, catalogSource: "cli" },
    ]);
  });

  test("executable catalog cache expires explicitly, retries failures, and preserves last good data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delegate-catalog-"));
    const previousCli = process.env.PI_DELEGATE_CLI;
    try {
      const script = resolve(dir, "catalog.ts");
      const counter = resolve(dir, "count.txt");
      const failMarker = resolve(dir, "fail");
      const fixture = resolve(addonDir, "fixtures/cli-models-29.txt");
      writeFileSync(script, `
        import { existsSync, readFileSync, writeFileSync } from "node:fs";
        const counter = ${JSON.stringify(counter)};
        const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
        writeFileSync(counter, String(count + 1));
        if (existsSync(${JSON.stringify(failMarker)})) { console.error("fixture discovery failed"); process.exit(2); }
        process.stdout.write(readFileSync(${JSON.stringify(fixture)}, "utf8"));
      `);
      process.env.PI_DELEGATE_CLI = `${process.execPath} ${script}`;
      const fresh = await getExecutableCatalog(true);
      expect(fresh).toMatchObject({ stale: false, lastError: null });
      expect(fresh.models).toHaveLength(29);
      expect(readFileSync(counter, "utf8")).toBe("1");
      const cached = await getExecutableCatalog(false);
      expect(cached.refreshedAt).toBe(fresh.refreshedAt);
      expect(readFileSync(counter, "utf8")).toBe("1");

      writeFileSync(failMarker, "fail");
      invalidateExecutableCatalog();
      const stale = await getExecutableCatalog(false);
      expect(stale).toMatchObject({ stale: true, lastError: "fixture discovery failed" });
      expect(stale.models).toHaveLength(29);
      expect(readFileSync(counter, "utf8")).toBe("2");
      const retried = await getExecutableCatalog(false);
      expect(retried.models).toHaveLength(29);
      expect(readFileSync(counter, "utf8")).toBe("3");
    } finally {
      if (previousCli === undefined) delete process.env.PI_DELEGATE_CLI;
      else process.env.PI_DELEGATE_CLI = previousCli;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cancellation interrupts executable-model discovery before delegation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delegate-discovery-abort-"));
    const previousCli = process.env.PI_DELEGATE_CLI;
    try {
      const script = resolve(dir, "slow-catalog.ts");
      writeFileSync(script, "await Bun.sleep(5000); console.log('Provider Model Context MaxOut Thinking Images');");
      process.env.PI_DELEGATE_CLI = `${process.execPath} ${script}`;
      invalidateExecutableCatalog();
      let tool: any;
      delegateAddon({
        on() {},
        getActiveTools() { return []; },
        setActiveTools() {},
        registerTool(candidate: any) { if (candidate.name === "delegate") tool = candidate; },
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const started = Date.now();
      await expect(tool.execute("abort-discovery", { prompt: "never runs", timeout_sec: 10 }, controller.signal, undefined, {
        model: { provider: "github-copilot", id: "gpt-5.6-sol" },
        modelRegistry: { async refresh() {}, getAvailable() { return []; } },
      })).rejects.toThrow(/aborted/i);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      if (previousCli === undefined) delete process.env.PI_DELEGATE_CLI;
      else process.env.PI_DELEGATE_CLI = previousCli;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("model matching picks up close direct-provider equivalents and excludes azure providers by default", () => {
    const models = [
      { provider: "github-copilot", id: "gpt-5.4-mini", fullId: "github-copilot/gpt-5.4-mini" },
      { provider: "openai", id: "gpt-5.4-mini", fullId: "openai/gpt-5.4-mini" },
      { provider: "anthropic", id: "claude-fable-5", fullId: "anthropic/claude-fable-5" },
      { provider: "anthropic", id: "claude-sonnet-4.6", fullId: "anthropic/claude-sonnet-4.6" },
      { provider: "azure-openai", id: "gpt-5.4-mini", fullId: "azure-openai/gpt-5.4-mini" },
    ];
    const candidates = buildModelCandidates(models, { searchable_providers: null, excluded_providers: null, excluded_models: [] });
    expect(candidates.some((candidate) => candidate.id === "openai/gpt-5.4-mini" && candidate.tier === 2)).toBe(true);
    expect(candidates.some((candidate) => candidate.id === "anthropic/claude-fable-5" && candidate.tier === 3)).toBe(true);
    expect(candidates.some((candidate) => candidate.id === "anthropic/claude-sonnet-4.6" && candidate.tier === 3)).toBe(true);
    expect(candidates.some((candidate) => candidate.provider.startsWith("azure-"))).toBe(false);
  });

  test("provider and model exclusions are configurable", () => {
    const models = [
      { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
      { provider: "github-copilot", id: "gpt-5.4-mini", fullId: "github-copilot/gpt-5.4-mini" },
      { provider: "openai", id: "gpt-5.4-mini", fullId: "openai/gpt-5.4-mini" },
      { provider: "azure-openai", id: "gpt-5.4-mini", fullId: "azure-openai/gpt-5.4-mini" },
      { provider: "openai-codex", id: "gpt-5.4", fullId: "openai-codex/gpt-5.4" },
    ];
    const includeAzure = buildModelCandidates(models, { searchable_providers: null, excluded_providers: [], excluded_models: [] });
    expect(includeAzure.some((candidate) => candidate.id === "azure-openai/gpt-5.4-mini")).toBe(true);

    const excludeOpenAi = buildModelCandidates(models, { searchable_providers: null, excluded_providers: ["openai"], excluded_models: [] });
    expect(excludeOpenAi.some((candidate) => candidate.provider === "openai")).toBe(false);

    const excludeMini = buildModelCandidates(models, { searchable_providers: null, excluded_providers: [], excluded_models: ["*mini*"] });
    expect(excludeMini.some((candidate) => candidate.modelId.includes("mini"))).toBe(false);
    expect(excludeMini.some((candidate) => candidate.id === "openai-codex/gpt-5.4")).toBe(true);
    const chain = buildDelegateModelChain("code", 3, "github-copilot/gpt-5.5", excludeMini);
    expect(chain.every((id) => !id.includes("mini"))).toBe(true);
  });

  test("provider toggles constrain matching and preserve configured preference order", () => {
    const models = [
      { provider: "github-copilot", id: "gpt-5.4-mini", fullId: "github-copilot/gpt-5.4-mini" },
      { provider: "openai", id: "gpt-5.4-mini", fullId: "openai/gpt-5.4-mini" },
      { provider: "anthropic", id: "claude-sonnet-4.6", fullId: "anthropic/claude-sonnet-4.6" },
    ];
    const candidates = buildModelCandidates(models, { searchable_providers: ["anthropic"], excluded_providers: null, excluded_models: [] });
    expect(candidates.every((candidate) => candidate.provider === "anthropic")).toBe(true);
    expect(candidates.some((candidate) => candidate.id === "anthropic/claude-sonnet-4.6")).toBe(true);
    expect(buildModelCandidates(models, { searchable_providers: [], excluded_providers: null, excluded_models: [] })).toEqual([]);
    const ordered = buildModelCandidates(models, { searchable_providers: ["openai", "github-copilot"], excluded_providers: [], excluded_models: [] });
    expect(ordered.filter((candidate) => candidate.modelId === "gpt-5.4-mini").map((candidate) => candidate.provider)).toEqual(["openai", "github-copilot"]);
  });

  test("deterministic classification does not cross major model variants", () => {
    expect(classifyModel("openai/gpt-5.4-mini")).toMatchObject({ status: "classified", tier: 2, family: "gpt", rule: "gpt-mini", confidence: "exact-policy" });
    expect(classifyModel("openai/gpt-5.4")).toMatchObject({ status: "classified", tier: 3, family: "gpt", rule: "gpt-5-4", confidence: "exact-policy" });
    expect(classifyModel("openai/mystery-9000")).toMatchObject({ status: "unclassified", tier: null, rule: null, confidence: "none" });
    const candidates = buildModelCandidates([
      { provider: "openai", id: "gpt-5.4", fullId: "openai/gpt-5.4" },
    ], { searchable_providers: null, excluded_providers: null, excluded_models: [] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: "openai/gpt-5.4", tier: 3, sourceId: "gpt-5-4", matchScore: 100 });
  });

  test("classifies every current runtime and executable fixture exactly once", () => {
    const runtimeFixture = JSON.parse(readFileSync(resolve(addonDir, "fixtures/runtime-models-42.json"), "utf8")) as {
      current: string;
      models: Array<{ label: string; provider: string; id: string }>;
    };
    const runtimeClassifications = runtimeFixture.models.map((model) => classifyModel(model));
    expect(runtimeClassifications.filter((classification) => classification.status === "unclassified")).toEqual([]);
    const runtimeCandidates = buildModelCandidates(runtimeFixture.models.map((model) => ({ ...model, fullId: model.label })), {
      searchable_providers: null,
      excluded_providers: [],
      excluded_models: [],
    });
    expect(runtimeCandidates).toHaveLength(runtimeFixture.models.length);
    expect(new Set(runtimeCandidates.map((candidate) => candidate.id)).size).toBe(runtimeCandidates.length);

    const executableModels = parsePiListModelsOutput(readFileSync(resolve(addonDir, "fixtures/cli-models-29.txt"), "utf8"));
    const executableCandidates = buildModelCandidates(executableModels, { searchable_providers: null, excluded_providers: [], excluded_models: [] });
    expect(executableModels).toHaveLength(29);
    expect(executableCandidates).toHaveLength(29);
    expect(new Set(executableCandidates.map((candidate) => candidate.id)).size).toBe(29);
    expect(executableCandidates.every((candidate) => candidate.classificationConfidence === "exact-policy")).toBe(true);
  });

  test("ordered policy covers the current named families and provider variants", () => {
    const expected: Record<string, [number, string]> = {
      "openai-codex/gpt-5.5": [3, "gpt-5-5"],
      "openai-codex/gpt-5.6-sol": [3, "gpt-5-6"],
      "github-copilot/claude-sonnet-5": [3, "claude-sonnet-5"],
      "github-copilot/claude-opus-4.8": [5, "claude-opus"],
      "github-copilot/gemini-3.5-flash": [2, "gemini-flash"],
      "github-copilot/mai-code-1-flash-picker": [2, "mai-code-flash"],
      "cerebras/gemma-4-31b": [2, "gemma"],
      "ollama/qwen3.5:35b": [2, "qwen"],
      "azure-openai/gpt-5-4-pro": [4, "gpt-pro"],
      "azure-foundry/deepseek-v4-flash": [2, "deepseek-flash"],
    };
    for (const [id, [tier, policyRule]] of Object.entries(expected)) {
      expect(classifyModel(id)).toMatchObject({ status: "classified", tier, rule: policyRule });
    }
  });

  test("runtime metadata enriches exact executable models and unknown current models fail closed", async () => {
    const runtimeModel = {
      provider: "github-copilot",
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      contextWindow: 272_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ["text", "image"],
    };
    expect(runtimeModelToAvailable(runtimeModel)).toMatchObject({ fullId: "github-copilot/gpt-5.6-sol", contextWindow: 272_000, maxOutputTokens: 128_000, reasoning: true, supportsImages: true, catalogSource: "runtime" });
    const snapshot = await captureRuntimeCatalog({ model: runtimeModel, modelRegistry: { async refresh() {}, getAvailable: () => [runtimeModel, runtimeModel] } });
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.currentModel?.fullId).toBe("github-copilot/gpt-5.6-sol");
    const merged = mergeExecutableRuntimeMetadata([
      { provider: "github-copilot", id: "gpt-5.6-sol", fullId: "github-copilot/gpt-5.6-sol", contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: false, supportsImages: false, catalogSource: "cli" },
      { provider: "ollama", id: "qwen3.5:35b", fullId: "ollama/qwen3.5:35b", contextWindow: 32_000, supportsImages: false, catalogSource: "cli" },
    ], snapshot.models);
    expect(merged[0]).toMatchObject({ contextWindow: 272_000, maxOutputTokens: 128_000, reasoning: true, supportsImages: true, catalogSource: "cli" });
    expect(merged[1]).toMatchObject({ contextWindow: 32_000, supportsImages: false, catalogSource: "cli" });
    expect(getCurrentTier({ model: runtimeModel })).toBe(3);
    expect(getCurrentTier({ model: { provider: "custom", id: "unknown-model" } })).toBeNull();
  });

  test("runtime catalog passively reads one coherent snapshot and preserves last-good data", async () => {
    const freshModel = { provider: "github-copilot", id: "gpt-5.6-sol", input: ["text", "image"] };
    let refreshes = 0;
    let reads = 0;
    const ctx = {
      model: freshModel,
      modelRegistry: {
        async refresh() { refreshes++; },
        getAvailable() {
          reads++;
          return [freshModel];
        },
      },
    };

    const fresh = await captureRuntimeCatalog(ctx);
    expect(refreshes).toBe(0);
    expect(reads).toBe(1);
    expect(fresh.models.map((model) => model.fullId)).toEqual(["github-copilot/gpt-5.6-sol"]);

    const retained = await captureRuntimeCatalog({
      model: freshModel,
      modelRegistry: {
        async refresh() { refreshes++; },
        getAvailable() { throw new Error("registry unavailable"); },
      },
    }, fresh);
    expect(refreshes).toBe(0);
    expect(retained.models).toEqual(fresh.models);
    expect(retained.currentModel?.fullId).toBe("github-copilot/gpt-5.6-sol");
  });

  test("workspace root follows Piclaw configuration and standalone cwd", () => {
    expect(getDelegateWorkspaceRoot({ PICLAW_WORKSPACE: "/workspace" }, "/tmp")).toBe("/workspace");
    expect(getDelegateWorkspaceRoot({}, process.cwd())).toBe(process.cwd());
  });

  test("file inspection accepts only Pi-native raster formats and rejects unsupported binaries", () => {
    const workspaceTempRoot = getDelegateWorkspaceRoot();
    const dir = mkdtempSync(join(workspaceTempRoot, ".delegate-files-"));
    try {
      const fixtures: Array<[string, Buffer, string]> = [
        ["image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "PNG"],
        ["image.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "JPEG"],
        ["image.gif", Buffer.from("GIF89a", "ascii"), "GIF"],
        ["image.webp", Buffer.from("RIFF0000WEBP", "ascii"), "WebP"],
        ["image.bmp", Buffer.from("BM", "ascii"), "BMP"],
      ];
      for (const [name, content, format] of fixtures) {
        const path = resolve(dir, name);
        writeFileSync(path, content);
        expect(inspectDelegateFile(path)).toEqual({ kind: "image", format });
      }
      const rejected: Array<[string, Buffer, string]> = [
        ["document.pdf", Buffer.from("%PDF-1.7", "ascii"), "PDF"],
        ["drawing.svg", Buffer.from("<svg viewBox=\"0 0 1 1\"></svg>", "utf8"), "SVG"],
        ["archive.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04]), "ZIP archive"],
        ["scan.tiff", Buffer.from([0x49, 0x49, 0x2a, 0x00]), "TIFF"],
      ];
      for (const [name, content, format] of rejected) {
        const path = resolve(dir, name);
        writeFileSync(path, content);
        expect(inspectDelegateFile(path)).toMatchObject({ kind: "unsupported", format });
      }
      const fakePng = resolve(dir, "fake.png");
      writeFileSync(fakePng, "plain text");
      expect(inspectDelegateFile(fakePng)).toMatchObject({ kind: "unsupported", format: "invalid image" });
      const text = resolve(dir, "notes.md");
      writeFileSync(text, "hello\n");
      expect(inspectDelegateFile(text)).toEqual({ kind: "text", format: "text" });
      expect(prepareDelegateFile(text)).toMatchObject({ resolved: text, size: 6, inspection: { kind: "text" } });

      const outsideLink = resolve(dir, "outside.txt");
      symlinkSync("/etc/hosts", outsideLink);
      expect(() => prepareDelegateFile(outsideLink)).toThrow("Path outside workspace");

      const fifo = resolve(dir, "blocking.fifo");
      const mkfifo = Bun.spawnSync(["mkfifo", fifo]);
      expect(mkfifo.exitCode).toBe(0);
      const started = Date.now();
      expect(() => prepareDelegateFile(fifo)).toThrow("regular files");
      expect(Date.now() - started).toBeLessThan(250);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("image capability diagnostics distinguish explicit non-support from unknown metadata", () => {
    expect(describeImageCapability({ id: "provider/no-vision", supportsImages: false })).toBe("provider/no-vision (images=no)");
    expect(describeImageCapability({ id: "provider/unknown", supportsImages: null })).toBe("provider/unknown (image capability unknown)");
    expect(describeImageCapability({ id: "provider/vision", supportsImages: true })).toBeNull();
  });

  test("explicit overrides require exact executable models and obey hard model exclusions", () => {
    const executable = [
      { provider: "openai-codex", id: "gpt-5.4", fullId: "openai-codex/gpt-5.4" },
      { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
      { provider: "github-copilot", id: "gpt-5.4-mini", fullId: "github-copilot/gpt-5.4-mini" },
    ];
    const runtime = [
      ...executable,
      { provider: "github-copilot", id: "gpt-5.6-sol", fullId: "github-copilot/gpt-5.6-sol" },
    ];
    const hardExclusions = { searchable_providers: null, excluded_providers: [], excluded_models: ["*mini*"] };
    expect(validateExplicitDelegateModel("openai-codex/gpt-5.4", executable, runtime, hardExclusions)).toMatchObject({ model: executable[0], policyBypass: true, error: null });
    for (const model of ["github-copilot/gpt-5-mini", "github-copilot/gpt-5.4-mini"]) {
      expect(validateExplicitDelegateModel(model, executable, runtime, hardExclusions)).toMatchObject({ model: null, policyBypass: true });
      expect(validateExplicitDelegateModel(model, executable, runtime, hardExclusions).error).toContain("matches a configured model exclusion");
    }
    expect(validateExplicitDelegateModel("github-copilot/gpt-5.6-sol", executable, runtime, hardExclusions).error).toContain("available in Piclaw but not executable");
    expect(validateExplicitDelegateModel("unknown/missing", executable, runtime, hardExclusions).error).toContain("not available in the child Pi CLI catalog");
    expect(validateExplicitDelegateModel("GPT-5.4", executable, runtime, hardExclusions).error).toContain("exact provider/model ID");
  });

  test("judge selection crosses families only when a valid candidate exists", () => {
    const mixed = buildModelCandidates([
      { provider: "github-copilot", id: "gpt-5.4", fullId: "github-copilot/gpt-5.4" },
      { provider: "github-copilot", id: "claude-sonnet-4.6", fullId: "github-copilot/claude-sonnet-4.6" },
    ], { searchable_providers: null, excluded_providers: [], excluded_models: [] });
    expect(selectModel("judge", 3, "github-copilot/gpt-5.5", mixed)).toBe("github-copilot/claude-sonnet-4.6");
    const sameFamily = mixed.filter((candidate) => candidate.family === "gpt");
    expect(selectModel("judge", 3, "github-copilot/gpt-5.5", sameFamily)).toBe("github-copilot/gpt-5.4");
  });

  test("delegate resolves a runnable CLI command", () => {
    const cli = resolveDelegateCliCommand();
    expect(cli.command.length).toBeGreaterThan(0);
    expect(Array.isArray(cli.argsPrefix)).toBe(true);
    expect(cli.label.length).toBeGreaterThan(0);
  });

  test("delegate runs the Pi CLI through the current runtime instead of node PATH", () => {
    const cliPath = "/opt/pi/dist/cli.js";
    const cli = resolveDelegateCliCommand({
      env: { PATH: "/bin", BUN_INSTALL: "/missing" },
      platform: "linux",
      execPath: "/runtime/bun",
      resolvePackageCli: () => cliPath,
      exists: (path) => path === cliPath,
      isExecutable: () => false,
    });
    expect(cli).toEqual({
      command: "/runtime/bun",
      argsPrefix: [cliPath],
      label: `/runtime/bun ${cliPath}`,
    });
  });

  test("delegate PATH fallback handles Windows shims without POSIX executable bits", () => {
    const cli = resolveDelegateCliCommand({
      env: { PATH: "C:\\Tools;C:\\Windows", PATHEXT: ".CMD;.EXE" },
      platform: "win32",
      execPath: "C:\\Runtime\\bun.exe",
      resolvePackageCli: () => null,
      exists: () => false,
      isExecutable: (path, platform) => platform === "win32" && /pi\.CMD$/i.test(path),
    });
    expect(cli.command).toMatch(/pi\.CMD$/i);
    expect(cli.argsPrefix).toEqual([]);
  });

  test("delegate settings pane exposes provider/model exclusions and model refresh", () => {
    const source = readFileSync(resolve(addonDir, "web/index.ts"), "utf8");
    expect(source).toContain("type=\"checkbox\"");
    expect(source).toContain("Filter providers");
    expect(source).toContain("Excluded model patterns");
    expect(source).toContain("Hard model exclusions");
    expect(source).toContain("explicit overrides");
    expect(source).toContain("Save exclusions");
    expect(source).toContain("Refresh");
    expect(source).toContain("models");
  });

  test("equal-id matches prefer the github-copilot reference provider over other providers", () => {
    // Regression: the @github session (github-copilot/gpt-5.5) delegated to
    // openai-codex/gpt-5.4 which has no usable key. The github-copilot equivalent
    // must rank first when scores tie.
    const models = [
      { provider: "openai-codex", id: "gpt-5.4", fullId: "openai-codex/gpt-5.4" },
      { provider: "github-copilot", id: "gpt-5.4", fullId: "github-copilot/gpt-5.4" },
    ];
    const candidates = buildModelCandidates(models, { searchable_providers: null, excluded_providers: null, excluded_models: [] });
    const tier3 = candidates.filter((candidate) => candidate.tier === 3 && candidate.modelId === "gpt-5.4");
    expect(tier3[0]?.id).toBe("github-copilot/gpt-5.4");
  });

  test("automatic selection never climbs above the category target tier", () => {
    const candidates = buildModelCandidates([
      { provider: "github-copilot", id: "claude-sonnet-5", fullId: "github-copilot/claude-sonnet-5" },
      { provider: "github-copilot", id: "claude-opus-4.8", fullId: "github-copilot/claude-opus-4.8" },
    ], { searchable_providers: null, excluded_providers: [], excluded_models: [] });
    expect(selectModel("quick", 5, "github-copilot/claude-opus-4.8", candidates)).toBeNull();
    expect(buildDelegateModelChain("quick", 5, "github-copilot/claude-opus-4.8", candidates)).toEqual([]);
  });

  test("model chain puts the github-copilot pick first and keeps other providers as fallbacks", () => {
    const models = [
      { provider: "openai-codex", id: "gpt-5.4", fullId: "openai-codex/gpt-5.4" },
      { provider: "github-copilot", id: "gpt-5.4", fullId: "github-copilot/gpt-5.4" },
      { provider: "github-copilot", id: "gpt-5.4-mini", fullId: "github-copilot/gpt-5.4-mini" },
    ];
    const candidates = buildModelCandidates(models, { searchable_providers: null, excluded_providers: null, excluded_models: [] });
    const chain = buildDelegateModelChain("code", 3, "github-copilot/gpt-5.5", candidates);
    expect(chain[0]).toBe("github-copilot/gpt-5.4");
    expect(chain).toContain("openai-codex/gpt-5.4");
    expect(new Set(chain).size).toBe(chain.length); // distinct entries
  });

  test("isProviderAuthError matches credential failures", () => {
    expect(isProviderAuthError("No API key for provider: openai-codex")).toBe(true);
    expect(isProviderAuthError("Provider not authenticated")).toBe(true);
    expect(isProviderAuthError("unauthorized")).toBe(true);
    expect(isProviderAuthError("Process exited with code 1")).toBe(false);
    expect(isProviderAuthError("")).toBe(false);
  });

  test("fallback taxonomy retries only setup, auth, and unavailable-model failures", () => {
    const expected = [
      ["No API key for provider openai", "auth", true],
      ["unknown model gpt-x", "model-unavailable", true],
      ["provider foo not found", "provider-setup", true],
      ["rate limit exceeded", "execution", false],
      ["No valid JSON events were emitted", "protocol", false],
      ["timed out after 10s", "timeout", false],
    ] as const;
    for (const [message, kind, retryable] of expected) {
      expect(classifyDelegateFailure(message)).toBe(kind);
      expect(isRetryableDelegateFailure(kind)).toBe(retryable);
    }
  });

  test("parses structured JSON events, usage, model, errors, and bounded output", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      provider: "github-copilot",
      model: "gpt-5.4-mini",
      responseModel: "routed-mini",
      stopReason: "stop",
      responseId: "response-1",
      timestamp: 1,
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, reasoning: 1, totalTokens: 16, cost: { total: 0.001 } },
    };
    const parsed = parseDelegateJsonOutput([
      JSON.stringify({ type: "session", id: "ephemeral-id" }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "1", toolName: "read", isError: false }),
      JSON.stringify({ type: "message_end", message }),
      JSON.stringify({ type: "turn_end", message, toolResults: [] }),
    ].join("\n"));
    expect(parsed).toMatchObject({ text: "done", provider: "github-copilot", model: "gpt-5.4-mini", responseModel: "routed-mini", stopReason: "stop", sessionId: "ephemeral-id", toolCallCount: 1, malformedEventCount: 0 });
    expect(parsed.usage).toMatchObject({ input: 10, output: 4, cacheRead: 2, reasoning: 1, totalTokens: 16, cost: 0.001 });
    expect(delegateProcessFailure(parsed)).toBeNull();

    const partialFailure = { ...parsed, exitCode: 1, stderr: "provider crashed" };
    expect(delegateProcessFailure(partialFailure)).toContain("Process exited with code 1");
    expect(delegateProcessFailure(partialFailure)).toContain("provider crashed");

    const errorMessage = { ...message, responseId: "response-2", content: [], stopReason: "error", errorMessage: "unknown model" };
    const errorResult = parseDelegateJsonOutput(JSON.stringify({ type: "message_end", message: errorMessage }));
    expect(delegateProcessFailure(errorResult)).toContain("unknown model");

    const largeMessage = { ...message, responseId: "response-3", content: [{ type: "text", text: "x".repeat(120_000) }] };
    const largeResult = parseDelegateJsonOutput(JSON.stringify({ type: "message_end", message: largeMessage }));
    expect(largeResult.outputTruncated).toBe(true);
    expect(largeResult.text.length).toBe(100_000);
  });

  test("runs JSON mode with progress and no persistent-session flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delegate-runner-"));
    try {
      const script = resolve(dir, "fixture.ts");
      writeFileSync(script, `
        await Bun.stdin.text();
        const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
        console.log(JSON.stringify({ type: "session", id: "fixture-session" }));
        console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} }));
        console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "1", toolName: "read", isError: false }));
        console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixture response" }], provider: "test", model: "fixture", usage, stopReason: "stop", timestamp: 1 } }));
      `);
      const progress: string[] = [];
      const run = await runDelegateProcess(
        ["--mode", "json", "--no-session"],
        "fixture prompt",
        3_000,
        undefined,
        (event) => progress.push(event.message),
        { command: process.execPath, argsPrefix: [script] },
      );
      expect(run).toMatchObject({ text: "fixture response", exitCode: 0, model: "fixture", stopReason: "stop", toolCallCount: 1 });
      expect(progress).toEqual(["Running read", "Completed read"]);
      const source = readFileSync(resolve(addonDir, "delegate.ts"), "utf8");
      expect(source).toContain('["--mode", "json", "--no-session", "--no-extensions"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("timeout terminates the delegated process tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delegate-timeout-"));
    try {
      const marker = resolve(dir, "orphan.txt");
      const childScript = resolve(dir, "child.ts");
      const parentScript = resolve(dir, "parent.ts");
      writeFileSync(childScript, `import { writeFileSync } from "node:fs"; await Bun.sleep(700); writeFileSync(${JSON.stringify(marker)}, "orphan");`);
      writeFileSync(parentScript, `import { spawn } from "node:child_process"; spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`);
      await expect(runDelegateProcess([], "", 100, undefined, undefined, { command: process.execPath, argsPrefix: [parentScript] })).rejects.toThrow("timed out");
      await Bun.sleep(900);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("abort signals terminate the delegated child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delegate-abort-"));
    try {
      const script = resolve(dir, "wait.ts");
      writeFileSync(script, "setInterval(() => {}, 1000);");
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      await expect(runDelegateProcess([], "", 3_000, controller.signal, undefined, { command: process.execPath, argsPrefix: [script] })).rejects.toThrow("Aborted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("delegate package stays dependency-light for add-on installs", () => {
    const manifest = JSON.parse(readFileSync(resolve(addonDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies || {}).toEqual({});
    expect(manifest.peerDependencies || {}).toEqual({});
    const source = readFileSync(resolve(addonDir, "delegate.ts"), "utf8");
    expect(source).not.toContain(`@sinclair/${"typebox"}`);
    expect(source).not.toContain(`@earendil-works/${"pi-coding-agent"}`);
  });
});
