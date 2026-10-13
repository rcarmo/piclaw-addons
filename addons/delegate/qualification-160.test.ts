import { expect, test, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDelegateChildTools, classifyDelegateFailure, getExecutableCatalog, resolvePiPackageCli, runDelegateProcess } from "./delegate.ts";

// Repository preload supplies disposable HOME/profile/workspace and removes credentials.
async function fixture(run: (f: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "delegate-160-"));
  const globals = globalThis as any;
  const registrar = globals.__piclaw_registerAddonConfigApi;
  const oldCli = process.env.PI_DELEGATE_CLI;
  try {
    const cli = join(root, "cli.ts"), attempts = join(root, "attempts.jsonl");
    writeFileSync(cli, `import {appendFileSync} from 'node:fs';
      const args=process.argv.slice(2);
      if(args.includes('--list-models')) {
        if(!args.includes('--no-extensions')) throw Error('discovery extension bypass');
        console.log('provider model context max-out thinking images');
        console.log('github-copilot gpt-6-sol 1M 128K yes yes');
        console.log('openai-codex gpt-6-sol 1M 128K yes yes');
        process.exit(0);
      }
      const prompt=await Bun.stdin.text();
      appendFileSync(${JSON.stringify(attempts)},JSON.stringify(args)+'\\n');
      const id=args[args.indexOf('--model')+1];
      const failure=id.startsWith('github-copilot/') ? prompt : '';
      console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:id.split('/')[0],model:'gpt-6-sol',content:[{type:'text',text:'partial fixture text'}],stopReason:failure?'error':'stop',errorMessage:failure||undefined}}));
      if(failure)process.exit(1);
    `);
    process.env.PI_DELEGATE_CLI = `${process.execPath} ${cli}`;
    let config: any, tool: any, thinking = "medium";
    globals.__piclaw_registerAddonConfigApi = (_id: string, action: string, api: any) => { if (action === "config") config = api; };
    const module = await import(`./delegate.ts?qualification160=${encodeURIComponent(root)}`);
    globals.__piclaw_registerAddonConfigApi = registrar;
    module.default({ on() {}, getThinkingLevel() { return thinking; }, registerTool(value: any) { tool = value; } });
    await config.set({ searchable_providers: ["github-copilot", "openai-codex"], excluded_providers: [], excluded_models: [] });
    const ctx = { model: { provider: "github-copilot", id: "gpt-6-sol" }, modelRegistry: { getAvailable() { return []; } } };
    const launches = () => existsSync(attempts) ? readFileSync(attempts, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    await run({ tool, config, ctx, launches, setThinking(level: string) { thinking = level; } });
  } finally {
    if (registrar === undefined) delete globals.__piclaw_registerAddonConfigApi; else globals.__piclaw_registerAddonConfigApi = registrar;
    if (oldCli === undefined) delete process.env.PI_DELEGATE_CLI; else process.env.PI_DELEGATE_CLI = oldCli;
    rmSync(root, { recursive: true, force: true });
  }
}

test("explicit built-ins are MCP-none even when an adapter exists; profiles retain one wrapper", () => {
  for (const adapter of [null, "/fixture/adapter/index.ts"]) {
    expect(buildDelegateChildTools("read, read,grep", adapter)).toEqual({ toolsArg: "read,grep", mcpPath: null });
    expect(() => buildDelegateChildTools("delegate", adapter)).toThrow("cannot load requested");
    expect(() => buildDelegateChildTools("native_mcp", adapter)).toThrow("cannot load requested");
  }
  expect(buildDelegateChildTools("read_only", "/fixture/adapter/index.ts")).toEqual({ toolsArg: "read,grep,find,ls,mcp", mcpPath: "/fixture/adapter/index.ts" });
  expect(buildDelegateChildTools("read,mcp,mcp", "/fixture/adapter/index.ts")).toEqual({ toolsArg: "read,mcp", mcpPath: "/fixture/adapter/index.ts" });
  expect(buildDelegateChildTools(undefined, null)).toEqual({ toolsArg: "read,grep,find,ls,bash", mcpPath: null });
  expect(() => buildDelegateChildTools("mcp", null)).toThrow("cannot load requested");
});

test("approved fallback re-reads thinking at launch and preserves explicit MCP-none argv", async () => {
  await fixture(async ({ tool, ctx, launches, setThinking }) => {
    const response = await tool.execute("fallback", { prompt: "unknown model: fixture", task_category: "code", tools: "read" }, undefined, (update: any) => {
      if (update.details.attempt === 2) setThinking("high");
    }, ctx);
    const attempts = launches();
    expect(attempts).toHaveLength(2);
    expect(attempts.map((args: string[]) => args[args.indexOf("--model") + 1])).toEqual(["github-copilot/gpt-6-sol", "openai-codex/gpt-6-sol"]);
    expect(attempts.map((args: string[]) => args[args.indexOf("--thinking") + 1])).toEqual(["medium", "high"]);
    for (const args of attempts) {
      expect(args).toContain("--no-session"); expect(args).toContain("--no-extensions");
      expect(args).not.toContain("-e"); expect(args[args.indexOf("--tools") + 1]).toBe("read");
      expect(args.join(" ")).not.toContain("MCP: use");
    }
    expect(response.details.fallback_count).toBe(1);
  });
});

for (const auth of ["invalid credentials", "invalid_grant", "Failed to refresh OAuth token", "refresh failed for token", "OpenAI Codex token refresh error: fixture", "xAI OAuth refresh failed (HTTP 401)", "access token expired", "provider logged out"]) {
  test(`mixed setup error and ${auth} never switches approved provider`, async () => {
    const message = `unknown model: fixture; ${auth}`;
    expect(classifyDelegateFailure(message)).toBe("auth");
    await fixture(async ({ tool, ctx, launches }) => {
      await expect(tool.execute("auth", { prompt: message, task_category: "code", tools: "read" }, undefined, undefined, ctx)).rejects.toThrow("[auth]");
      expect(launches()).toHaveLength(1);
    });
  });
}

test("explicit approved setup failure never falls back; excluded fallback cannot launch", async () => {
  await fixture(async ({ tool, ctx, config, launches }) => {
    await expect(tool.execute("explicit", { prompt: "unknown model: fixture", model: "github-copilot/gpt-6-sol", tools: "read" }, undefined, undefined, ctx)).rejects.toThrow("[model-unavailable]");
    expect(launches()).toHaveLength(1);
    await config.set({ excluded_providers: ["openai-codex"] });
    await expect(tool.execute("excluded", { prompt: "unknown model: fixture", task_category: "code", tools: "read" }, undefined, undefined, ctx)).rejects.toThrow("[model-unavailable]");
    expect(launches()).toHaveLength(2);
    expect(launches().every((args: string[]) => args[args.indexOf("--model") + 1] === "github-copilot/gpt-6-sol")).toBe(true);
  });
});

for (const expiredAttempt of [1, 2]) test(`deadline includes synchronous progress/setup before attempt ${expiredAttempt}`, async () => {
  await fixture(async ({ tool, ctx, launches }) => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    try {
      await expect(tool.execute("deadline", { prompt: "unknown model: fixture", task_category: "code", tools: "read", timeout_sec: 10 }, undefined, (update: any) => {
        if (update.details.attempt === expiredAttempt) offset = 10_001;
      }, ctx)).rejects.toThrow("timed out");
      expect(launches()).toHaveLength(expiredAttempt - 1);
    } finally { clock.mockRestore(); }
  });
});

test("abort from launch progress cannot spawn or fall back", async () => {
  await fixture(async ({ tool, ctx, launches }) => {
    const controller = new AbortController();
    await expect(tool.execute("abort", { prompt: "unknown model: fixture", task_category: "code", tools: "read" }, controller.signal, () => controller.abort(), ctx)).rejects.toThrow("aborted");
    expect(launches()).toEqual([]);
  });
});

// Real local packaged CLI, not a provider fixture. A deliberately nonexistent
// provider/model prevents a provider dispatch. This proves startup/flags only.
test("local Pi 1.1.0 packaged CLI admits MCP-none flags without default extension loading", async () => {
  const pkg = join(import.meta.dir, "../../node_modules/@earendil-works/pi-coding-agent");
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  expect(manifest.version).toBe("1.1.0");
  const cli = resolvePiPackageCli(join(pkg, "package.json"));
  expect(cli).not.toBeNull();
  const root = mkdtempSync(join(tmpdir(), "delegate-160-pi11-"));
  const old = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "PICLAW_WORKSPACE", "PI_OFFLINE", "PI_TELEMETRY", "OTEL_SDK_DISABLED"].map(key => [key, process.env[key]]));
  try {
    const profile = join(root, "profile"), workspace = join(root, "workspace"), marker = join(root, "unwanted-extension");
    for (const dir of [profile, workspace, join(profile, "extensions"), join(workspace, ".pi/extensions")]) mkdirSync(dir, { recursive: true });
    // Module side effects deliberately require no SDK interfaces or credentials.
    for (const dir of [join(profile, "extensions"), join(workspace, ".pi/extensions")]) {
      writeFileSync(join(dir, "poison.ts"), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'loaded');throw Error('UNWANTED_EXTENSION_LOADED');`);
    }
    Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: profile, PICLAW_WORKSPACE: workspace, PI_OFFLINE: "1", PI_TELEMETRY: "0", OTEL_SDK_DISABLED: "true" });
    const override = { command: process.execPath, argsPrefix: ["--no-env-file", cli!] };
    const version = await runDelegateProcess(["--offline", "--version"], "", 10_000, undefined, undefined, override);
    expect(version.exitCode).toBe(0); // version stdout is intentionally not JSON
    const catalog = await getExecutableCatalog(true, 10_000, undefined, { ...override, label: "isolated Pi 1.1.0" });
    expect(catalog.cliPackageVersion).toBeNull(); // --no-env-file prefix is not a manifest provenance claim
    const result = await runDelegateProcess(["--offline", "--mode", "json", "--no-session", "--no-extensions", "--model", "__delegate_missing__/__missing__", "--tools", "read", "--thinking", "medium"], "offline startup only", 10_000, undefined, undefined, override);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/model|provider/i);
    expect(result.stderr).not.toContain("UNWANTED_EXTENSION_LOADED");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(profile, "sessions"))).toBe(false);
    expect(readdirSync(workspace)).toEqual([".pi"]);
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
