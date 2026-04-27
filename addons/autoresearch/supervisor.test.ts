import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  describeAutoresearchTerminalReason,
  resolveAutoresearchIdleOutcome,
  resolveAutoresearchProcessExitState,
} from "./supervisor.js";

function createFakeExtensionApi() {
  const tools = new Map<string, any>();
  const handlers: Array<{ event: string; handler: (...args: any[]) => any }> = [];
  return {
    api: {
      on(event: string, handler: (...args: any[]) => any) { handlers.push({ event, handler }); },
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
      getThinkingLevel: () => "off" as any,
      setThinkingLevel() {},
      registerProvider() {},
      unregisterProvider() {},
    },
    tools,
    handlers,
  };
}

function getHandler(handlers: Array<{ event: string; handler: (...args: any[]) => any }>, event: string) {
  const match = handlers.find((entry) => entry.event === event);
  if (!match) throw new Error(`Missing handler: ${event}`);
  return match.handler;
}

test("describeAutoresearchTerminalReason humanizes known supervisor reasons", () => {
  expect(describeAutoresearchTerminalReason("process_exited")).toContain("process exited");
  expect(describeAutoresearchTerminalReason("max_iterations_idle")).toContain("max-iteration budget");
  expect(describeAutoresearchTerminalReason("general_idle")).toContain("30 minutes");
  expect(describeAutoresearchTerminalReason("user_stopped")).toBe("Stopped by user request.");
  expect(describeAutoresearchTerminalReason("")).toBeNull();
});

test("resolveAutoresearchIdleOutcome distinguishes complete-vs-stalled idle endings", () => {
  expect(resolveAutoresearchIdleOutcome(true)).toEqual({
    state: "completed",
    reason: "max_iterations_idle",
  });
  expect(resolveAutoresearchIdleOutcome(false)).toEqual({
    state: "failed",
    reason: "general_idle",
  });
});

test("resolveAutoresearchProcessExitState only treats process exit as complete when max iterations were reached", () => {
  expect(resolveAutoresearchProcessExitState({ totalRuns: 0 }, null)).toBe("failed");
  expect(resolveAutoresearchProcessExitState({ totalRuns: 2 }, null)).toBe("failed");
  expect(resolveAutoresearchProcessExitState({ totalRuns: 2 }, 3)).toBe("failed");
  expect(resolveAutoresearchProcessExitState({ totalRuns: 3 }, 3)).toBe("completed");
});

test("autoresearch supervisor messaging describes git worktree mode instead of direct in-repo edits", () => {
  const source = readFileSync(resolve(import.meta.dir, "./supervisor.ts"), "utf8");
  expect(source).toContain("When off, runs in a fresh git worktree on a new branch in the same repo.");
  expect(source).toContain("Branch: ${branchName} (git worktree mode)");
  expect(source).toContain("⚠️ Git worktree mode — changes are made in a fresh git worktree on branch ${branchName} within the same repo.");
  expect(source).not.toContain("runs directly in the repo on a new git branch");
  expect(source).not.toContain("Branch: ${branchName} (direct mode)");
});

test("vendored pi-autoresearch uses current Pi session lifecycle events", () => {
  const source = readFileSync(
    resolve(import.meta.dir, "./vendor/autoresearch/extensions/pi-autoresearch/index.ts"),
    "utf8",
  );

  expect(source).toContain('pi.on("session_start"');
  expect(source).toContain('pi.on("session_before_fork"');
  expect(source).not.toContain('pi.on("session_switch"');
  expect(source).not.toContain('pi.on("session_fork"');
});

test("vendored autoresearch experiment tools opt into self-managed render shells", async () => {
  const fake = createFakeExtensionApi();
  const { default: vendorExtension } = await import("./vendor/autoresearch/extensions/pi-autoresearch/index.ts");
  vendorExtension(fake.api);

  expect(fake.tools.get("init_experiment")?.renderShell).toBe("self");
  expect(fake.tools.get("run_experiment")?.renderShell).toBe("self");
  expect(fake.tools.get("log_experiment")?.renderShell).toBe("self");
});

test("vendored autoresearch clears its widget UI on session shutdown", async () => {
  const fake = createFakeExtensionApi();
  const { default: vendorExtension } = await import("./vendor/autoresearch/extensions/pi-autoresearch/index.ts");
  vendorExtension(fake.api);

  const start = getHandler(fake.handlers, "session_start");
  const shutdown = getHandler(fake.handlers, "session_shutdown");
  const widgetCalls: Array<{ key: string; value: unknown }> = [];
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      setWidget: (key: string, value: unknown) => widgetCalls.push({ key, value }),
      setStatus() {},
      notify() {},
      theme: { fg: (_name: string, text: string) => text },
    },
    sessionManager: {
      getSessionId: () => "session-shutdown-test",
      getBranch: () => [],
    },
  };

  await start({}, ctx);
  await shutdown({}, ctx);

  expect(widgetCalls).toContainEqual({ key: "autoresearch", value: undefined });
});
