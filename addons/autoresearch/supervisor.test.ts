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
      registerEntryRenderer() {},
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
      events: {
        on() { return () => {}; },
        emit() {},
      },
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
  expect(readFileSync(resolve(import.meta.dir, "./launch-surface.ts"), "utf8")).toContain("When off, runs in a fresh git worktree on a new branch in the same repo.");
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

test('the Express picker captures one experiment and does not launch before its owned action', async () => {
  const { postAutoresearchLaunch } = await import('./launch-surface.js');
  const host = globalThis as typeof globalThis & { __piclaw_runtime?: any };
  const previous = host.__piclaw_runtime;
  const posts: any[] = [];
  const launches: unknown[] = [];
  host.__piclaw_runtime = { a2ui: { version: 1, post: async (request: unknown) => posts.push(request) } };
  try {
    const first = { project_dir: '/workspace/project-one', prompt:'" text \n root = Text("not code")', chat_jid:'web:one', variables:['original'] };
    const start = async (params: unknown) => { launches.push(params); return 'Started'; };
    expect(await postAutoresearchLaunch(first, [{ label:'test/one', contextWindow:40_000 }], 'test/one', start)).toBe(1);
    expect(await postAutoresearchLaunch({ project_dir:'/workspace/project-two',prompt:'Second',chat_jid:'web:two' }, [{ label:'test/two' }], null, start)).toBe(2);
    first.variables[0] = 'edited';
    expect(launches).toEqual([]);
    expect(posts[0].express).toContain(JSON.stringify(first.prompt));
    expect(posts[0].express).toContain('40k ctx');
    const sent: string[] = [];
    const callback = { chatJid:'web:one',values:{ model:['test/one'],sandbox:false },sendMessage: async (content: string) => { sent.push(content); } };
    await expect(posts[0].actions.launch({...callback, chatJid:'web:two'})).rejects.toThrow();
    await expect(posts[0].actions.launch({...callback, values:{model:['test/two'],sandbox:false}})).rejects.toThrow();
    await posts[0].actions.launch(callback);
    expect(launches).toEqual([{ ...first, variables:['original'], model:'test/one', sandbox:false }]);
    expect(sent).toEqual(['Launching with model **test/one**…','Started']);
  } finally { if (previous === undefined) delete host.__piclaw_runtime; else host.__piclaw_runtime = previous; }
});
