import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  consumeGoalDeadlineAgentEndSuppression,
  goalDeadlineCheckpointProvider as provider,
  resetGoalDeadlineCheckpointForTests,
} from "./deadline-checkpoint.js";

const chatJid = "web:deadline-goal";
const values = new Map<string, unknown>();
const key = (extensionId: string, name: string, scope = "chat", scopeKey = "") => `${extensionId}:${scope}:${scopeKey}:${name}`;
const store = {
  get: (extensionId: string, name: string, scope?: string, scopeKey?: string) => values.get(key(extensionId, name, scope, scopeKey)) ?? null,
  set: (extensionId: string, name: string, value: unknown, scope?: string, scopeKey?: string) => { values.set(key(extensionId, name, scope, scopeKey), structuredClone(value)); },
  delete: (extensionId: string, name: string, scope?: string, scopeKey?: string) => values.delete(key(extensionId, name, scope, scopeKey)),
  list: () => [],
  clear: () => 0,
};

function saveGoal(overrides: Record<string, unknown> = {}) {
  store.set("goal", "thread-goal", {
    goal_id: "goal-1",
    chat_jid: chatJid,
    objective: "Ship issue 917",
    status: "active",
    token_budget: 10_000,
    tokens_used: 100,
    ...overrides,
  }, "chat", chatJid);
}

function latch() {
  return provider.tryLatch({
    chatJid,
    operationId: "op-1",
    sourceSeq: 41,
    operationGeneration: 2,
    oldTurnId: "turn-1",
    checkpointId: "checkpoint-1",
    deadlineAt: new Date(Date.now() + 100).toISOString(),
  });
}

beforeEach(() => {
  values.clear();
  resetGoalDeadlineCheckpointForTests();
  (globalThis as any).__piclawRuntimeInterop = { getExtensionKvStore: () => store };
  (globalThis as any).__piclaw_planSidebarApi = {
    getPlan: () => ({ plan: [
      { step: "Implement", status: "completed" },
      { step: "Test", status: "in_progress" },
    ] }),
  };
});

afterEach(() => {
  resetGoalDeadlineCheckpointForTests();
  delete (globalThis as any).__piclawRuntimeInterop;
  delete (globalThis as any).__piclaw_planSidebarApi;
});

test("deadline checkpoint latches only an active persisted Goal with a current Plan", () => {
  expect(latch()).toBeNull();
  saveGoal({ status: "paused" });
  expect(latch()).toBeNull();
  saveGoal();
  const lease = latch();
  expect(lease?.goalId).toBe("goal-1");
  expect(lease?.planFingerprint).toContain("Test");
  expect(latch()).toBeNull();
});

test("deadline checkpoint revalidates replacement, pause, completion and stop", () => {
  saveGoal();
  const lease = latch()!;
  expect(provider.revalidate(lease).action).toBe("continue");
  saveGoal({ status: "paused" });
  expect(provider.revalidate(lease).action).toBe("suppress");
  saveGoal({ status: "complete", completion_summary: "Done", completion_evidence: ["tests pass"] });
  expect(provider.revalidate(lease)).toMatchObject({ action: "complete", visibleText: "Goal completed: Done\n- tests pass" });
  saveGoal({ status: "stopped", stop_summary: "Blocked", stop_evidence: ["dependency"] });
  expect(provider.revalidate(lease)).toMatchObject({ action: "stop", visibleText: "Goal stopped: Blocked\n- dependency" });
  saveGoal({ goal_id: "goal-2" });
  expect(provider.revalidate(lease).action).toBe("suppress");
});

test("scheduled checkpoint persists exact ownership and only resolves exact replay identity", () => {
  saveGoal();
  const lease = latch()!;
  expect(provider.resolveContinuation({ chatJid, goalId: "goal-1", checkpointId: "checkpoint-1", generation: 3 }))
    .toEqual({ status: "suppress" });
  provider.markScheduled(lease, { generation: 3 });
  const scheduled = store.get("goal", "thread-goal", "chat", chatJid) as any;
  expect(scheduled.deadline_checkpoint).toMatchObject({
    checkpoint_id: "checkpoint-1",
    operation_id: "op-1",
    source_seq: 41,
    operation_generation: 2,
    continuation_generation: 3,
    old_turn_id: "turn-1",
    status: "scheduled",
  });
  expect(provider.resolveContinuation({ chatJid, goalId: "goal-1", checkpointId: "other", generation: 3 })).toEqual({ status: "suppress" });
  expect(provider.resolveContinuation({ chatJid, goalId: "goal-1", checkpointId: "checkpoint-1", generation: 4 })).toEqual({ status: "suppress" });
  const resolved = provider.resolveContinuation({ chatJid, goalId: "goal-1", checkpointId: "checkpoint-1", generation: 3 });
  expect(resolved.status).toBe("continue");
  if (resolved.status === "continue") {
    expect(resolved.content).toContain("Ship issue 917");
    expect(resolved.content).toContain("[-] Test");
  }
  expect((store.get("goal", "thread-goal", "chat", chatJid) as any).deadline_checkpoint).toMatchObject({
    checkpoint_id: "checkpoint-1",
    continuation_generation: 3,
    status: "claimed",
  });
  expect(provider.resolveContinuation({ chatJid, goalId: "goal-1", checkpointId: "checkpoint-1", generation: 3 }).status).toBe("continue");
});

test("agent_end suppression is exact-turn, single-use, and survives provider release", () => {
  saveGoal();
  const lease = latch()!;
  expect(consumeGoalDeadlineAgentEndSuppression(chatJid, "turn-other")).toBe(false);
  expect(consumeGoalDeadlineAgentEndSuppression(chatJid, "turn-1")).toBe(true);
  expect(consumeGoalDeadlineAgentEndSuppression(chatJid, "turn-1")).toBe(false);
  const second = latch()!;
  provider.release(second);
  expect(consumeGoalDeadlineAgentEndSuppression(chatJid, "turn-other")).toBe(false);
  expect(consumeGoalDeadlineAgentEndSuppression(chatJid, "turn-1")).toBe(true);
  expect(consumeGoalDeadlineAgentEndSuppression(chatJid, "turn-1")).toBe(false);
  provider.release(lease);
});

test("continuation is suppressed after cancellation, Plan clear, or Goal replacement", () => {
  saveGoal();
  const lease = latch()!;
  provider.markScheduled(lease, { generation: 3 });
  saveGoal({ status: "paused" });
  expect(provider.resolveContinuation({ chatJid, goalId: "goal-1", checkpointId: "checkpoint-1", generation: 3 })).toEqual({ status: "suppress" });
  saveGoal();
  (globalThis as any).__piclaw_planSidebarApi = { getPlan: () => ({ plan: [] }) };
  expect(provider.resolveContinuation({ chatJid, goalId: "goal-1", checkpointId: "checkpoint-1", generation: 3 })).toEqual({ status: "suppress" });
  saveGoal({ goal_id: "goal-new" });
  expect(provider.resolveContinuation({ chatJid, goalId: "goal-1", checkpointId: "checkpoint-1", generation: 3 })).toEqual({ status: "suppress" });
});
