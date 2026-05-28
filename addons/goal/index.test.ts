import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import goalAddon, {
  buildGoalBudgetLimitPrompt,
  buildGoalContinuationPrompt,
  createThreadGoal,
  flushGoalPromptDispatchesForTests,
  goalResponse,
  loadThreadGoal,
  resetGoalAddonForTests,
  resolveActiveChatJid,
  setGoalPromptSenderForTests,
} from "./index.ts";
import { withChatContext } from "./compat/chat-context.ts";

const addonDir = import.meta.dir;

afterEach(async () => {
  await flushGoalPromptDispatchesForTests();
  resetGoalAddonForTests();
  delete (globalThis as { __piclawRuntimeInterop?: unknown }).__piclawRuntimeInterop;
  delete (globalThis as { __PICLAW_BROADCAST_EVENT__?: unknown }).__PICLAW_BROADCAST_EVENT__;
});

function createHarness(options: { confirm?: boolean; pending?: boolean; idle?: boolean } = {}) {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const handlers: Array<{ event: string; handler: (...args: any[]) => any }> = [];
  const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const confirmations: string[] = [];

  const api = {
    on(event: string, handler: (...args: any[]) => any) { handlers.push({ event, handler }); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    sendMessage(message: unknown, options?: unknown) { sentMessages.push({ message, options }); },
    sendUserMessage(content: unknown, options?: unknown) { sentUserMessages.push({ content, options }); },
  } as any;

  setGoalPromptSenderForTests(async (_goal, content) => {
    sentUserMessages.push({ content, options: { via: "local-agent-endpoint" } });
  });

  const ctx = {
    ui: {
      notify(message: string, level = "info") { notifications.push({ message, level }); },
      async confirm(message: string) { confirmations.push(message); return options.confirm === true; },
    },
    sessionManager: { getSessionDir: () => "/tmp/web_default" },
    isIdle: () => options.idle !== false,
    hasPendingMessages: () => options.pending === true,
  } as any;

  goalAddon(api);
  return { api, commands, tools, handlers, sentUserMessages, sentMessages, notifications, confirmations, ctx };
}

test("goal addon exports an extension entrypoint", () => {
  expect(typeof goalAddon).toBe("function");
});

test("goal manifest declares the web entry", () => {
  const manifest = JSON.parse(readFileSync(resolve(addonDir, "package.json"), "utf8")) as any;
  expect(manifest.name).toBe("@rcarmo/piclaw-addon-goal");
  expect(manifest.pi?.web?.entries).toEqual(["web/index.ts"]);
});

test("goal README documents Codex-compatible tools and statuses", () => {
  const readme = readFileSync(resolve(addonDir, "README.md"), "utf8");
  expect(readme).toContain("get_goal");
  expect(readme).toContain("create_goal");
  expect(readme).toContain("update_goal");
  expect(readme).toContain("budget_limited");
  expect(readme).toContain("blocked");
});

test("goal web pane targets the thread-goal addon API", () => {
  const source = readFileSync(resolve(addonDir, "web", "index.ts"), "utf8");
  expect(source).toContain("const API = `/agent/addons/api/${ADDON_ID}/goal`");
  expect(source).toContain("registerSettingsPane");
  expect(source).toContain("goal.thread-goal-updated");
  expect(source).toContain("get_goal");
  expect(source).toContain("create_goal");
  expect(source).toContain("update_goal");
  expect(source).not.toContain("`${API}/config`");
  expect(source).not.toContain("`${API}/session`");
});

test("resolveActiveChatJid falls back to the session directory for web branches", () => {
  const ctx = {
    sessionManager: {
      getSessionDir: () => "/workspace/.pi/agent/sessions/web_branch-123",
    },
  } as any;
  expect(resolveActiveChatJid(ctx)).toBe("web:branch-123");
});

test("createThreadGoal stores Codex-shaped state and rejects duplicates", () => {
  const goal = createThreadGoal("web:goal", "Ship <unsafe> & verify", 1234);
  expect(goal.objective).toBe("Ship <unsafe> & verify");
  expect(goal.status).toBe("active");
  expect(goal.token_budget).toBe(1234);
  expect(goal.tokens_used).toBe(0);
  expect(goal.time_used_seconds).toBe(0);
  expect(loadThreadGoal("web:goal")?.goal_id).toBe(goal.goal_id);
  expect(() => createThreadGoal("web:goal", "second")).toThrow(/already has a goal/);
});

test("goalResponse matches Codex-style tool response fields", () => {
  const goal = createThreadGoal("web:goal", "Ship docs", 100);
  const response = goalResponse(goal);
  expect(response.goal).toMatchObject({
    threadId: "web:goal",
    goalId: goal.goal_id,
    objective: "Ship docs",
    status: "active",
    tokenBudget: 100,
    tokensUsed: 0,
    timeUsedSeconds: 0,
  });
  expect(response.remainingTokens).toBe(100);
  expect(response.completionBudgetReport).toBeNull();
});

test("goal prompts port Codex fidelity, escaping, plan action=update, and blocked audit language", () => {
  const goal = createThreadGoal("web:goal", "Fix <x> & ship", 1000);
  const continuation = buildGoalContinuationPrompt(goal);
  expect(continuation).toContain("Fix &lt;x&gt; &amp; ship");
  expect(continuation).toContain("If the plan tool is available");
  expect(continuation).toContain("plan action=update");
  expect(continuation).toContain("Completion audit:");
  expect(continuation).toContain("Blocked audit:");
  expect(continuation).toContain("at least three consecutive goal turns");
  const budget = buildGoalBudgetLimitPrompt(goal);
  expect(budget).toContain("has reached its token budget");
  expect(budget).toContain("Do not call update_goal unless the goal is actually complete");
});

describe("Codex-style goal tools", () => {
  test("registers get_goal, create_goal, and update_goal", () => {
    const { tools } = createHarness();
    expect([...tools.keys()].sort()).toEqual(["create_goal", "get_goal", "update_goal"]);
  });

  test("create_goal and get_goal share persisted thread goal state", async () => {
    const { tools, ctx } = createHarness();
    const createGoal = tools.get("create_goal");
    const getGoal = tools.get("get_goal");

    const created = await createGoal.execute("call-1", { objective: "Ship goal port", token_budget: 500 }, undefined, undefined, ctx);
    expect(created.details.goal.status).toBe("active");
    expect(created.details.remainingTokens).toBe(500);

    const read = await getGoal.execute("call-2", {}, undefined, undefined, ctx);
    expect(read.details.goal.objective).toBe("Ship goal port");
  });

  test("update_goal can complete with final usage report", async () => {
    const { tools, ctx } = createHarness();
    await tools.get("create_goal").execute("call-1", { objective: "Close checklist", token_budget: 500 }, undefined, undefined, ctx);
    const result = await tools.get("update_goal").execute("call-2", { status: "complete", summary: "Verified." }, undefined, undefined, ctx);
    expect(result.details.goal.status).toBe("complete");
    expect(result.details.completionBudgetReport).toContain("Goal achieved");
    expect(loadThreadGoal("web:default")?.status).toBe("complete");
  });

  test("update_goal can mark blocked", async () => {
    const { tools, ctx } = createHarness();
    await tools.get("create_goal").execute("call-1", { objective: "Wait for external service" }, undefined, undefined, ctx);
    const result = await tools.get("update_goal").execute("call-2", { status: "blocked", summary: "Service unavailable three turns." }, undefined, undefined, ctx);
    expect(result.details.goal.status).toBe("blocked");
    expect(loadThreadGoal("web:default")?.last_blocker).toContain("Service unavailable");
  });
});

describe("/goal command and runtime loop", () => {
  test("/goal starts a thread goal and asynchronously queues the Codex continuation prompt", async () => {
    const { commands, sentUserMessages, sentMessages, notifications, ctx } = createHarness();
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Ship the release", ctx);
    });
    const goal = loadThreadGoal("web:goal");
    expect(goal?.objective).toBe("Ship the release");
    expect(goal?.status).toBe("active");
    expect(sentUserMessages).toHaveLength(1);
    await flushGoalPromptDispatchesForTests();
    expect(String(sentUserMessages[0]?.content)).toBe("🎯 Continue goal: Ship the release");
    expect(sentUserMessages[0]?.options).toEqual({ via: "local-agent-endpoint" });
    expect(notifications.at(-1)?.message).toContain("server-side continuation queued");
  });

  test("/goal replaces an existing goal without hidden confirmation", async () => {
    const { commands, sentUserMessages, confirmations, ctx } = createHarness({ confirm: false });
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("First goal", ctx);
      await commands.get("goal").handler("Second goal", ctx);
    });
    expect(confirmations).toHaveLength(0);
    expect(loadThreadGoal("web:goal")?.objective).toBe("Second goal");
    expect(loadThreadGoal("web:goal")?.status).toBe("active");
    expect(sentUserMessages).toHaveLength(2);
    expect(String(sentUserMessages[1]?.content)).toBe("🎯 Goal updated: Second goal");
  });

  test("/goal pause, resume, and clear are user-controlled", async () => {
    const { commands, sentUserMessages, ctx } = createHarness();
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      await commands.get("goal").handler("pause", ctx);
      expect(loadThreadGoal("web:goal")?.status).toBe("paused");
      await commands.get("goal").handler("resume", ctx);
      expect(loadThreadGoal("web:goal")?.status).toBe("active");
      await commands.get("goal").handler("clear", ctx);
      expect(loadThreadGoal("web:goal")).toBeNull();
    });
    expect(sentUserMessages.length).toBeGreaterThanOrEqual(2);
  });

  test("queued goal prompts are swallowed after /goal stop regardless of queue", async () => {
    const { commands, handlers, sentUserMessages, sentMessages, ctx } = createHarness();
    const input = handlers.find((entry) => entry.event === "input")?.handler;
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      expect(String(sentUserMessages[0]?.content)).toBe("🎯 Continue goal: Finish docs");
      expect(String(sentUserMessages[0]?.content)).not.toContain("piclaw-goal");
      await commands.get("goal").handler("stop", ctx);
      expect(loadThreadGoal("web:goal")?.status).toBe("paused");
      const result = await input({ type: "input", text: sentUserMessages[0]?.content, source: "extension" }, ctx);
      expect(result).toEqual({ action: "handled" });
    });
    expect(String((sentMessages.at(-1)?.message as any)?.display)).toContain("skipped queued continuation continuation");
  });

  test("active goal prompts continue without timeline metadata", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness();
    const input = handlers.find((entry) => entry.event === "input")?.handler;
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      const result = await input({ type: "input", text: sentUserMessages[0]?.content, source: "extension" }, ctx);
      expect(result.action).toBe("transform");
      expect(result.text).toContain("Continue working toward the active thread goal");
      expect(String(sentUserMessages[0]?.content)).toBe("🎯 Continue goal: Finish docs");
      expect(String(sentUserMessages[0]?.content)).not.toContain("piclaw-goal");
    });
  });

  test("message_end accounts usage and agent_end emits continuation while active", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness();
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      await messageEnd({ message: { role: "assistant", usage: { totalTokens: 123 } } }, ctx);
      await agentEnd({}, ctx);
    });
    expect(loadThreadGoal("web:goal")?.tokens_used).toBe(123);
    expect(sentUserMessages).toHaveLength(2);
    expect(String(sentUserMessages[1]?.content)).toBe("🎯 Continue goal: Finish docs");
  });

  test("agent_end does not auto-continue when pending user input exists", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness({ pending: true });
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      await messageEnd({ message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 12 } } }, ctx);
      await agentEnd({}, ctx);
    });
    expect(sentUserMessages).toHaveLength(1);
  });

  test("agent_end does not auto-continue after a failed assistant turn", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness();
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      await messageEnd({ message: { role: "assistant", stopReason: "error", errorMessage: "400 No tool call found" } }, ctx);
      await agentEnd({}, ctx);
    });
    expect(sentUserMessages).toHaveLength(1);
  });

  test("agent_end does not auto-continue while the runtime is not idle", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness({ idle: false });
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      await messageEnd({ message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 12 } } }, ctx);
      await agentEnd({}, ctx);
    });
    expect(sentUserMessages).toHaveLength(1);
  });

  test("budget exhaustion marks budget_limited and emits wrap-up prompt once", async () => {
    const { handlers, sentUserMessages, ctx } = createHarness();
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    await withChatContext("web:goal", "web", async () => {
      createThreadGoal("web:goal", "Stabilize deployment", 100);
      await messageEnd({ message: { role: "assistant", usage: { totalTokens: 120 } } }, ctx);
      await agentEnd({}, ctx);
      await agentEnd({}, ctx);
    });
    expect(loadThreadGoal("web:goal")?.status).toBe("budget_limited");
    expect(sentUserMessages).toHaveLength(1);
    expect(String(sentUserMessages[0]?.content)).toBe("🎯 Goal budget reached: Stabilize deployment");
  });
});
