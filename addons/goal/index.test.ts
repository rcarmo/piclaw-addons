import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import goalAddon, {
  loadGoalSession,
  renderGoalTemplate,
  resetGoalAddonForTests,
  resolveActiveChatJid,
  saveGoalSession,
} from "./index.ts";
import { withChatContext } from "./compat/chat-context.ts";

const addonDir = import.meta.dir;

afterEach(() => {
  resetGoalAddonForTests();
  delete (globalThis as { __piclawRuntimeInterop?: unknown }).__piclawRuntimeInterop;
});

function createHarness() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const handlers: Array<{ event: string; handler: (...args: any[]) => any }> = [];
  const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const workingMessages: Array<string | undefined> = [];

  const api = {
    on(event: string, handler: (...args: any[]) => any) { handlers.push({ event, handler }); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, options: any) { commands.set(name, options); },
    registerShortcut() {},
    registerFlag() {},
    getFlag() { return undefined; },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage(content: unknown, options?: unknown) { sentUserMessages.push({ content, options }); },
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
    registerProvider() {},
    unregisterProvider() {},
    events: { on() {}, off() {}, emit() {} },
  } as any;

  const ctx = {
    ui: {
      notify(message: string, level = "info") {
        notifications.push({ message, level });
      },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
      setWorkingMessage(message?: string) {
        workingMessages.push(message);
      },
    },
    hasUI: false,
    cwd: "/workspace",
    sessionManager: { getSessionId: () => "session-1" },
    modelRegistry: {} as any,
    model: undefined,
    isIdle: () => true,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "base prompt",
    waitForIdle: async () => {},
  } as any;

  goalAddon(api);
  return { api, commands, tools, handlers, sentUserMessages, notifications, statuses, workingMessages, ctx };
}

test("goal addon exports an extension entrypoint", () => {
  expect(typeof goalAddon).toBe("function");
});

test("goal manifest declares the web entry", () => {
  const manifest = JSON.parse(readFileSync(resolve(addonDir, "package.json"), "utf8")) as any;
  expect(manifest.name).toBe("@rcarmo/piclaw-addon-goal");
  expect(manifest.pi?.web?.entries).toEqual(["web/index.ts"]);
});

test("goal README documents /goal and editable prompts", () => {
  const readme = readFileSync(resolve(addonDir, "README.md"), "utf8");
  expect(readme).toContain("/goal <objective>");
  expect(readme).toContain("Prompt placeholders");
  expect(readme).toContain("update_goal");
});

test("goal web entry targets config/session addon APIs and active chat context", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(source).toContain("const API = `/agent/addons/api/${ADDON_ID}`");
  expect(source).toContain("`${API}/config`");
  expect(source).toContain("`${API}/session`");
  expect(source).toContain("registerSettingsPane");
  expect(source).toContain("__piclaw_web?.getCurrentChatJid");
  expect(source).toContain("piclaw:current-chat-changed");
});

test("goal prompt editors are monospaced textareas", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(source).toContain('const PROMPT_TEXTAREA_STYLE = { ...I, minHeight: "110px", fontFamily: "var(--font-mono, monospace)", whiteSpace: "pre", tabSize: "2" }');
  expect(source).toContain('<textarea style=${PROMPT_TEXTAREA_STYLE} value=${config.system_prompt}');
  expect(source).toContain('<textarea style=${{ ...PROMPT_TEXTAREA_STYLE, minHeight: "220px" }} value=${config.continuation_prompt}');
  expect(source).toContain('<textarea style=${{ ...PROMPT_TEXTAREA_STYLE, minHeight: "170px" }} value=${config.budget_limit_prompt}');
  expect((source.match(/spellcheck="false"/g) || []).length).toBeGreaterThanOrEqual(3);
});

test("renderGoalTemplate replaces prompt placeholders", () => {
  const rendered = renderGoalTemplate("Goal: {{ objective }} / {{ tokens_used }} / {{ missing }}", {
    objective: "Ship docs",
    tokens_used: "42",
  });
  expect(rendered).toBe("Goal: Ship docs / 42 / ");
});

test("goal continuation prompts require visible timeline feedback", async () => {
  const { commands, sentUserMessages, ctx } = createHarness();
  const command = commands.get("goal");

  await withChatContext("web:goal", "web", async () => {
    await command.handler("Ship docs", ctx);
  });

  expect(String(sentUserMessages[0]?.content)).toContain("Timeline feedback requirement");
  expect(String(sentUserMessages[0]?.content)).toContain("visible user feedback in the timeline");
});

test("resolveActiveChatJid falls back to the session directory for web branches", () => {
  const ctx = {
    sessionManager: {
      getSessionDir: () => "/workspace/.pi/agent/sessions/web_branch-123",
    },
  } as any;
  expect(resolveActiveChatJid(ctx)).toBe("web:branch-123");
});

describe("goal command and loop behavior", () => {
  test("/goal uses Piclaw runtime chat context when not on web:default", async () => {
    (globalThis as { __piclawRuntimeInterop?: { getChatJid?: () => string; getChatChannel?: () => string } }).__piclawRuntimeInterop = {
      getChatJid: () => "web:branch-123",
      getChatChannel: () => "web",
    };
    const { commands, sentUserMessages, notifications, ctx } = createHarness();
    const command = commands.get("goal");

    await command.handler("Finish the branch-local task", ctx);

    const branchSession = loadGoalSession("web:branch-123");
    const defaultSession = loadGoalSession("web:default");
    expect(branchSession.objective).toBe("Finish the branch-local task");
    expect(branchSession.enabled).toBe(true);
    expect(defaultSession.objective).toBe("");
    expect(String(sentUserMessages[0]?.content)).toContain("Finish the branch-local task");
    expect(notifications.at(-1)?.message).toContain("web:branch-123");
  });

  test("/goal uses the session directory when Piclaw runtime interop is unavailable", async () => {
    const { commands, ctx, sentUserMessages, notifications } = createHarness();
    ctx.sessionManager.getSessionDir = () => "/workspace/.pi/agent/sessions/web_branch-456";
    const command = commands.get("goal");

    await command.handler("Finish the actual branch task", ctx);

    const branchSession = loadGoalSession("web:branch-456");
    const defaultSession = loadGoalSession("web:default");
    expect(branchSession.objective).toBe("Finish the actual branch task");
    expect(defaultSession.objective).toBe("");
    expect(String(sentUserMessages[0]?.content)).toContain("Finish the actual branch task");
    expect(notifications.at(-1)?.message).toContain("web:branch-456");
  });

  test("/goal starts a run with UI progress and queues the initial kickoff prompt", async () => {
    const { commands, sentUserMessages, notifications, statuses, workingMessages, ctx } = createHarness();
    const command = commands.get("goal");

    await withChatContext("web:goal", "web", async () => {
      await command.handler("Ship the release", ctx);
    });

    const session = loadGoalSession("web:goal");
    expect(session.objective).toBe("Ship the release");
    expect(session.enabled).toBe(true);
    expect(session.status).toBe("running");
    expect(sentUserMessages).toHaveLength(1);
    expect(String(sentUserMessages[0]?.content)).toContain("Ship the release");
    expect(statuses.at(-1)?.key).toBe("goal");
    expect(statuses.at(-1)?.text).toContain("Goal starting");
    expect(workingMessages.at(-1)).toContain("Goal starting");
    expect(notifications.at(-1)?.message).toContain("Started goal run");
  });

  test("before_agent_start injects the active goal system prompt", async () => {
    const { commands, handlers, ctx } = createHarness();
    const command = commands.get("goal");
    const beforeAgentStart = handlers.find((entry) => entry.event === "before_agent_start")?.handler;

    await withChatContext("web:goal", "web", async () => {
      await command.handler("Verify the site rebuild", ctx);
      const result = await beforeAgentStart({ systemPrompt: "base prompt" }, ctx);
      expect(result.systemPrompt).toContain("Verify the site rebuild");
      expect(result.systemPrompt).toContain("update_goal");
    });
  });

  test("agent_end queues a continuation prompt while budget remains", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness();
    const command = commands.get("goal");
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;

    await withChatContext("web:goal", "web", async () => {
      await command.handler("Finish the docs site", ctx);
      await messageEnd({ message: { role: "assistant", usage: { totalTokens: 123 } } }, ctx);
      await agentEnd({}, ctx);
    });

    expect(sentUserMessages).toHaveLength(2);
    expect(String(sentUserMessages[1]?.content)).toContain("Finish the docs site");
    expect(String(sentUserMessages[1]?.content)).toContain("Tokens used: 123");
  });

  test("update_goal marks completion and stops the continuation loop", async () => {
    const { commands, tools, handlers, sentUserMessages, ctx } = createHarness();
    const command = commands.get("goal");
    const updateGoal = tools.get("update_goal");
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;

    await withChatContext("web:goal", "web", async () => {
      await command.handler("Close the release checklist", ctx);
      await updateGoal.execute("tool-1", { status: "complete", summary: "Checklist and tests verified." }, undefined, undefined, ctx);
      await agentEnd({}, ctx);
    });

    const session = loadGoalSession("web:goal");
    expect(session.status).toBe("complete");
    expect(session.enabled).toBe(false);
    expect(session.completion_summary).toContain("Checklist");
    expect(sentUserMessages).toHaveLength(1);
  });

  test("agent_end emits a budget-limit wrap-up prompt and disables seeking when the budget is exhausted", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness();
    const command = commands.get("goal");
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;

    await withChatContext("web:goal", "web", async () => {
      await command.handler("Stabilize the deployment", ctx);
      saveGoalSession("web:goal", { tokens_used: 25000, token_budget: 20000 });
      await agentEnd({}, ctx);
    });

    const session = loadGoalSession("web:goal");
    expect(session.status).toBe("budget_limited");
    expect(session.enabled).toBe(false);
    expect(sentUserMessages).toHaveLength(2);
    expect(String(sentUserMessages[1]?.content)).toContain("has reached its token budget");
  });
});
