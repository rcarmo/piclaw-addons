import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAdapterTools, type AdapterActivationState } from "./src/adapter/profile-controller.ts";
import { mergeAdapterTools } from "./src/adapter/tool-set.ts";

test("profile restores captured tools and a subsequent activation captures fresh tools", () => {
  let active = ["read", "custom"];
  const pi = { getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; } };
  const ctx = { model: { provider: "openai-codex" }, hasUI: false } as any;
  const state: AdapterActivationState = { profile: "native" };
  syncAdapterTools(pi, ctx, state, ["exec_command"]);
  expect(active).toEqual(["exec_command", "custom"]);
  expect(state.previousToolNames).toEqual(["read", "custom"]);
  active.push("later");
  ctx.model = undefined;
  syncAdapterTools(pi, ctx, state, []);
  expect(active).toEqual(["read", "custom", "later"]);
  expect(state.previousToolNames).toBeUndefined();
  active = ["bash", "fresh"];
  ctx.model = { provider: "github-copilot", id: "gpt-5" };
  syncAdapterTools(pi, ctx, state, ["exec_command"]);
  ctx.model = undefined;
  syncAdapterTools(pi, ctx, state, []);
  expect(active).toEqual(["bash", "fresh"]);
  expect(mergeAdapterTools(["web_search", "custom", "custom"], ["exec_command", "web_search"]))
    .toEqual(["exec_command", "web_search", "custom"]);
});

test("standalone native public exports resolve the actual SDK12, without shared dependency mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-sdk12-exports-"));
  const targetRoot = process.env.CODEX_SDK12_ROOT ?? "/workspace/tmp/durable-packaging-1650";
  try {
    // Copy source: a source symlink would resolve dependencies back through the old addon root.
    cpSync(join(import.meta.dir, "src"), join(root, "src"), { recursive: true });
    symlinkSync(join(targetRoot, "node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "proof.ts"), `
      import { expect } from "bun:test";
      import * as sdk from "@earendil-works/pi-ai";
      import { readFileSync } from "node:fs";
      import * as native from "./src/native.ts";
      const sdkUrl = import.meta.resolve("@earendil-works/pi-ai");
      const pkg = JSON.parse(readFileSync(new URL("../package.json", sdkUrl), "utf8"));
      expect(pkg.version).toBe("1.2.0");
      expect(Object.keys(sdk).length).toBeGreaterThan(0);
      const names = ["createNativeCodexHooks", "resolveAdapterProfile", "rewriteNativeImageGenerationTool",
        "rewriteNativeWebSearchTool", "createNativeApplyPatchFactory", "createNativeWebSearchTool",
        "createNativeImageGenerationTool", "createNativeViewImageTool", "createNativeCodexProfile",
        "bindNativeCodexProvider", "createNativeCodexOutput"];
      expect(Object.keys(native).sort()).toEqual(names.sort());
      for (const name of names) expect(typeof native[name]).toBe("function");
      let active = ["read", "custom"];
      const profile = native.createNativeCodexProfile({ getActiveTools: () => active, setActiveTools: n => { active = n; } });
      const hooks = profile.modelSelect({ provider: "openai-codex", id: "gpt", api: "openai-codex-responses", input: ["image"] });
      expect(active).toContain("exec_command");
      expect(hooks.request({ tools: [{ type: "function", name: "web_search" }] }).tools[0].type).toBe("web_search");
      profile.modelSelect({ provider: "other", id: "gpt", api: "other" });
      expect(active).toEqual(["read", "custom"]);
      console.log("SDK12 public native import OK", sdkUrl, pkg.version);
    `);
    const result = Bun.spawnSync([process.execPath, join(root, "proof.ts")], { cwd: root, env: process.env });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(output).toContain("SDK12 public native import OK");
    if (result.exitCode) throw new Error(output);
    expect(result.exitCode).toBe(0);
    console.log(output.trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
