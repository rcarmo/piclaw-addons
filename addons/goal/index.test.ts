import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import goalAddon, {
  buildGoalBudgetLimitPrompt,
  buildGoalContinuationPrompt,
  buildGoalFinalizationPrompt,
  buildGoalSystemPrompt,
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
  delete (globalThis as { __piclaw_planSidebarApi?: unknown }).__piclaw_planSidebarApi;
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

function customMessageText(message: unknown): string {
  const content = (message as any)?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n");
  }
  return String(content ?? "");
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
  expect(continuation).toContain("goal_complete");
  expect(continuation).toContain("update_goal with status \"complete\"");
  const systemPrompt = buildGoalSystemPrompt(goal);
  expect(systemPrompt).toContain("## Active Goal");
  expect(systemPrompt).toContain("Codex-compatible fallback");
  expect(systemPrompt).toContain("update_goal({ status: \"complete\"");
  expect(systemPrompt).toContain("do not end the turn with only the tool call");
  const finalization = buildGoalFinalizationPrompt(goal, 1, [{ step: "Verify release", status: "completed" }]);
  expect(finalization).toContain("no pending or in-progress items");
  expect(finalization).toContain("call goal_complete");
  expect(finalization).toContain("call update_goal with status \"complete\"");
  expect(finalization).toContain("call goal_stop");
  const budget = buildGoalBudgetLimitPrompt(goal);
  expect(budget).toContain("has reached its token budget");
  expect(budget).toContain("Do not call goal_complete or update_goal(status=\"complete\") unless the goal is actually complete");
});

describe("Codex-style goal tools", () => {
  test("registers get_goal, create_goal, goal_complete, goal_stop, and update_goal", () => {
    const { tools } = createHarness();
    expect([...tools.keys()].sort()).toEqual(["create_goal", "get_goal", "goal_complete", "goal_stop", "update_goal"]);
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
    expect(read.details.terminalGuidance.join("\n")).toContain("update_goal({ status: \"complete\"");
    expect(read.details.terminalGuidance.join("\n")).toContain("goal_stop");
  });

  test("goal_complete records evidence without early-terminating the user-visible turn", async () => {
    const { tools, ctx } = createHarness();
    await tools.get("create_goal").execute("call-1", { objective: "Close checklist", token_budget: 500 }, undefined, undefined, ctx);
    const result = await tools.get("goal_complete").execute("call-2", { summary: "Checklist closed.", evidence: ["bun test passed", "commit abc123 pushed"] }, undefined, undefined, ctx);
    expect(result.details.goal.status).toBe("complete");
    expect(result.details.goal.completionSummary).toBe("Checklist closed.");
    expect(result.details.goal.completionEvidence).toEqual(["bun test passed", "commit abc123 pushed"]);
    expect(result.details.completionBudgetReport).toContain("Goal achieved");
    expect(result.content[0].text).toContain("Now provide a concise final answer to the user");
    expect(result.terminate).toBeUndefined();
    expect(loadThreadGoal("web:default")?.status).toBe("complete");
  });

  test("goal_stop records the stop reason without early-terminating the user-visible turn", async () => {
    const { tools, ctx } = createHarness();
    await tools.get("create_goal").execute("call-1", { objective: "Wait for external service" }, undefined, undefined, ctx);
    const result = await tools.get("goal_stop").execute("call-2", { reason: "user_needed", summary: "Need credentials.", evidence: ["401 from service"] }, undefined, undefined, ctx);
    expect(result.details.goal.status).toBe("stopped");
    expect(result.details.goal.stopReason).toBe("user_needed");
    expect(result.details.goal.stopEvidence).toEqual(["401 from service"]);
    expect(result.content[0].text).toContain("Now provide a concise final answer to the user");
    expect(result.terminate).toBeUndefined();
  });

  test("update_goal can complete with final usage report without early termination", async () => {
    const { tools, ctx } = createHarness();
    await tools.get("create_goal").execute("call-1", { objective: "Close checklist", token_budget: 500 }, undefined, undefined, ctx);
    const result = await tools.get("update_goal").execute("call-2", { status: "complete", summary: "Verified.", evidence: ["release check passed"] }, undefined, undefined, ctx);
    expect(result.details.goal.status).toBe("complete");
    expect(result.details.goal.completionSummary).toBe("Verified.");
    expect(result.details.goal.completionEvidence).toEqual(["release check passed"]);
    expect(result.details.completionBudgetReport).toContain("Goal achieved");
    expect(result.content[0].text).toContain("Now provide a concise final answer to the user");
    expect(result.terminate).toBeUndefined();
    expect(loadThreadGoal("web:default")?.status).toBe("complete");
  });

  test("update_goal complete requires evidence", async () => {
    const { tools, ctx } = createHarness();
    await tools.get("create_goal").execute("call-1", { objective: "Close checklist" }, undefined, undefined, ctx);
    await expect(tools.get("update_goal").execute("call-2", { status: "complete", summary: "Verified." }, undefined, undefined, ctx)).rejects.toThrow("requires at least one concrete evidence item");
    expect(loadThreadGoal("web:default")?.status).toBe("active");
  });

  test("update_goal can mark blocked", async () => {
    const { tools, ctx } = createHarness();
    await tools.get("create_goal").execute("call-1", { objective: "Wait for external service" }, undefined, undefined, ctx);
    const result = await tools.get("update_goal").execute("call-2", { status: "blocked", summary: "Service unavailable three turns." }, undefined, undefined, ctx);
    expect(result.details.goal.status).toBe("blocked");
    expect(result.content[0].text).toContain("Now provide a concise final answer to the user");
    expect(result.terminate).toBeUndefined();
    expect(loadThreadGoal("web:default")?.last_blocker).toContain("Service unavailable");
  });
});

describe("/goal command and runtime loop", () => {
  test("before_agent_start injects compact active-goal terminal guidance", async () => {
    const { handlers, ctx } = createHarness();
    const beforeAgentStart = handlers.find((entry) => entry.event === "before_agent_start")?.handler;
    createThreadGoal("web:default", "Ship docs", 100);
    const result = await beforeAgentStart({ systemPrompt: "base" }, ctx);
    expect(result.systemPrompt).toContain("## Active Goal");
    expect(result.systemPrompt).toContain("Ship docs");
    expect(result.systemPrompt).toContain("goal_complete({ summary, evidence })");
    expect(result.systemPrompt).toContain("update_goal({ status: \"complete\"");
  });

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

  test("/goal and /goal help post a visible command table with current status", async () => {
    const { commands, sentMessages, ctx } = createHarness();
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("", ctx);
      await commands.get("goal").handler("help", ctx);
    });
    const helpMessages = sentMessages.filter((entry) => (entry.message as any)?.customType === "goal_help");
    expect(helpMessages).toHaveLength(2);
    const body = customMessageText(helpMessages[0]?.message);
    expect((helpMessages[0]?.message as any)?.display).toBe(true);
    expect(body).toContain("/goal commands");
    expect(body).toContain("| Command | Action |");
    expect(body).toContain("`/goal pause`");
    expect(body).toContain("`/goal clear`");
    expect(body).toContain("No goal is currently set for web:goal.");
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
    expect(customMessageText(sentMessages.at(-1)?.message)).toContain("skipped queued continuation continuation");
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

  test("agent_end treats an all-completed plan as a finalization candidate instead of normal continuation", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness();
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    (globalThis as any).__piclaw_planSidebarApi = {
      getPlan: () => ({
        markdown: "- [x] Inspect\n- [x] Test",
        explanation: null,
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Test", status: "completed" },
        ],
      }),
    };
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      await messageEnd({ message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 12 } } }, ctx);
      await agentEnd({}, ctx);
    });
    expect(sentUserMessages).toHaveLength(2);
    expect(String(sentUserMessages[1]?.content)).toBe("🎯 Finalize goal: Finish docs");
    expect(loadThreadGoal("web:goal")?.completion_probe_count).toBe(1);
  });

  test("queued finalization prompts expand to completion-or-stop instructions", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness();
    const input = handlers.find((entry) => entry.event === "input")?.handler;
    (globalThis as any).__piclaw_planSidebarApi = {
      getPlan: () => ({ markdown: "- [x] done", explanation: null, plan: [{ step: "done", status: "completed" }] }),
    };
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      const goal = loadThreadGoal("web:goal")!;
      const candidate = { ...goal, completion_probe_count: 1 };
      const result = await input({ type: "input", text: `🎯 Finalize goal: ${goal.objective}`, source: "extension" }, ctx);
      expect(result.action).toBe("transform");
      expect(result.text).toContain("The current Plan Sidebar checklist has no pending or in-progress items");
      expect(result.text).toContain("call goal_complete");
      expect(result.text).toContain("call goal_stop");
      expect(candidate.completion_probe_count).toBe(1);
    });
    expect(sentUserMessages[0]?.content).toBe("🎯 Continue goal: Finish docs");
  });

  test("repeated unresolved all-completed plan auto-stops the goal loop", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness();
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    (globalThis as any).__piclaw_planSidebarApi = {
      getPlan: () => ({ markdown: "- [x] Inspect", explanation: null, plan: [{ step: "Inspect", status: "completed" }] }),
    };
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      for (let index = 0; index < 3; index += 1) {
        await messageEnd({ message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 1 } } }, ctx);
        await agentEnd({}, ctx);
      }
    });
    const goal = loadThreadGoal("web:goal");
    expect(goal?.status).toBe("stopped");
    expect(goal?.stop_reason).toBe("plan_complete_unverified");
    expect(sentUserMessages.map((msg) => String(msg.content))).toEqual([
      "🎯 Continue goal: Finish docs",
      "🎯 Finalize goal: Finish docs",
      "🎯 Finalize goal: Finish docs",
    ]);
  });

  test("repeated unchanged incomplete plans auto-stop as no progress", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness();
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    (globalThis as any).__piclaw_planSidebarApi = {
      getPlan: () => ({ markdown: "- [-] Implement\n- [ ] Test", explanation: null, plan: [
        { step: "Implement", status: "in_progress" },
        { step: "Test", status: "pending" },
      ] }),
    };
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      for (let index = 0; index < 3; index += 1) {
        await messageEnd({ message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 1 } } }, ctx);
        await agentEnd({}, ctx);
      }
    });
    const goal = loadThreadGoal("web:goal");
    expect(goal?.status).toBe("stopped");
    expect(goal?.stop_reason).toBe("no_progress");
    expect(sentUserMessages.map((msg) => String(msg.content))).toEqual([
      "🎯 Continue goal: Finish docs",
      "🎯 Continue goal: Finish docs",
      "🎯 Continue goal: Finish docs",
    ]);
  });

  test("agent_end auto-continues even when the last assistant message ended on a tool call", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness();
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      await messageEnd({ message: { role: "assistant", stopReason: "toolUse", usage: { totalTokens: 5 } } }, ctx);
      await agentEnd({}, ctx);
    });
    expect(sentUserMessages).toHaveLength(2);
    expect(String(sentUserMessages[1]?.content)).toBe("🎯 Continue goal: Finish docs");
  });

  test("a failing continuation dispatch does not throw out of agent_end", async () => {
    const { commands, handlers, ctx } = createHarness();
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    setGoalPromptSenderForTests(async () => { throw new Error("continuation endpoint down"); });
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      await messageEnd({ message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 5 } } }, ctx);
      await expect(agentEnd({}, ctx)).resolves.toBeUndefined();
    });
    expect(loadThreadGoal("web:goal")?.status).toBe("active");
  });

  test("real tool activity prevents the no-progress auto-stop when the plan is unchanged", async () => {
    const { commands, handlers, ctx } = createHarness();
    const beforeAgentStart = handlers.find((entry) => entry.event === "before_agent_start")?.handler;
    const toolEnd = handlers.find((entry) => entry.event === "tool_execution_end")?.handler;
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    (globalThis as any).__piclaw_planSidebarApi = {
      getPlan: () => ({ markdown: "- [-] Implement\n- [ ] Test", explanation: null, plan: [
        { step: "Implement", status: "in_progress" },
        { step: "Test", status: "pending" },
      ] }),
    };
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      for (let index = 0; index < 4; index += 1) {
        await beforeAgentStart({ systemPrompt: "base" }, ctx);
        toolEnd({ toolName: "bash" }, ctx);
        await messageEnd({ message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 1 } } }, ctx);
        await agentEnd({}, ctx);
      }
    });
    const goal = loadThreadGoal("web:goal");
    expect(goal?.status).toBe("active");
    expect(goal?.no_progress_turns).toBe(1);
  });

  test("goal-internal tool calls do not count as progress for the no-progress auto-stop", async () => {
    const { commands, handlers, ctx } = createHarness();
    const beforeAgentStart = handlers.find((entry) => entry.event === "before_agent_start")?.handler;
    const toolEnd = handlers.find((entry) => entry.event === "tool_execution_end")?.handler;
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    (globalThis as any).__piclaw_planSidebarApi = {
      getPlan: () => ({ markdown: "- [-] Implement", explanation: null, plan: [{ step: "Implement", status: "in_progress" }] }),
    };
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      for (let index = 0; index < 3; index += 1) {
        await beforeAgentStart({ systemPrompt: "base" }, ctx);
        toolEnd({ toolName: "get_goal" }, ctx);
        await messageEnd({ message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 1 } } }, ctx);
        await agentEnd({}, ctx);
      }
    });
    const goal = loadThreadGoal("web:goal");
    expect(goal?.status).toBe("stopped");
    expect(goal?.stop_reason).toBe("no_progress");
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

  test("agent_end auto-continues after a turn aborted purely for compaction", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness();
    const beforeAgentStart = handlers.find((entry) => entry.event === "before_agent_start")?.handler;
    const sessionCompact = handlers.find((entry) => entry.event === "session_compact")?.handler;
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      await beforeAgentStart({ systemPrompt: "base" }, ctx);
      // Mid-turn tool ceiling aborts the turn to force compaction.
      sessionCompact({ compactionEntry: { firstKeptEntryId: "x" } }, ctx);
      await messageEnd({ message: { role: "assistant", stopReason: "aborted", usage: { totalTokens: 7 } } }, ctx);
      await agentEnd({}, ctx);
    });
    expect(sentUserMessages).toHaveLength(2);
    expect(String(sentUserMessages[1]?.content)).toBe("🎯 Continue goal: Finish docs");
  });

  test("agent_end does not auto-continue after a user abort with no compaction", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness();
    const beforeAgentStart = handlers.find((entry) => entry.event === "before_agent_start")?.handler;
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      await beforeAgentStart({ systemPrompt: "base" }, ctx);
      await messageEnd({ message: { role: "assistant", stopReason: "aborted", usage: { totalTokens: 7 } } }, ctx);
      await agentEnd({}, ctx);
    });
    expect(sentUserMessages).toHaveLength(1);
  });

  test("agent_end still queues continuation when runtime reports non-idle during compaction", async () => {
    const { commands, handlers, sentUserMessages, ctx } = createHarness({ idle: false });
    const messageEnd = handlers.find((entry) => entry.event === "message_end")?.handler;
    const agentEnd = handlers.find((entry) => entry.event === "agent_end")?.handler;
    await withChatContext("web:goal", "web", async () => {
      await commands.get("goal").handler("Finish docs", ctx);
      await messageEnd({ message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 12 } } }, ctx);
      await agentEnd({}, ctx);
    });
    expect(sentUserMessages).toHaveLength(2);
    expect(String(sentUserMessages[1]?.content)).toBe("🎯 Continue goal: Finish docs");
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
