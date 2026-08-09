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

function saveGoalForChat(targetChatJid: string, overrides: Record<string, unknown> = {}) {
  store.set("goal", "thread-goal", {
    goal_id: "goal-1",
    lifecycle_generation: 7,
    chat_jid: targetChatJid,
    objective: "Ship issue 917",
    status: "active",
    token_budget: 10_000,
    tokens_used: 100,
    ...overrides,
  }, "chat", targetChatJid);
}

function saveGoal(overrides: Record<string, unknown> = {}) {
  saveGoalForChat(chatJid, overrides);
}

function resolve(generation = 3) {
  return provider.resolveContinuation({ chatJid, goalId: "goal-1", checkpointId: "checkpoint-1", generation });
}

function latch(overrides: Partial<Parameters<typeof provider.tryLatch>[0]> = {}) {
  return provider.tryLatch({
    chatJid,
    operationId: "op-1",
    sourceSeq: 41,
    operationGeneration: 2,
    oldTurnId: "turn-1",
    checkpointId: "checkpoint-1",
    deadlineAt: new Date(Date.now() + 100).toISOString(),
    ...overrides,
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

test("markScheduled retries preserve claimed evidence and validate the full owner", () => {
  saveGoal();
  const lease = latch()!;
  provider.markScheduled(lease, { generation: 3 });
  expect(resolve().status).toBe("continue");
  provider.markScheduled(lease, { generation: 3 });
  expect((store.get("goal", "thread-goal", "chat", chatJid) as any).deadline_checkpoint.status).toBe("claimed");
  expect(resolve().status).toBe("continue");
  expect(() => provider.markScheduled({ ...lease, operationId: "op-other" }, { generation: 3 }))
    .toThrow("Another Goal deadline checkpoint is still recoverable");
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

test("a live exact-turn suppression cannot be replaced after latch release", () => {
  saveGoal();
  const lease = latch()!;
  provider.release(lease);
  expect(latch({ checkpointId: "checkpoint-other" })).toBeNull();
  expect(consumeGoalDeadlineAgentEndSuppression(chatJid, "turn-1")).toBe(true);
});

test("runtime capacity rejects a new latch without evicting live suppressions", () => {
  const leases = [];
  for (let index = 0; index < 1_024; index += 1) {
    const targetChatJid = `web:capacity-${index}`;
    saveGoalForChat(targetChatJid);
    const lease = latch({
      chatJid: targetChatJid,
      operationId: `op-${index}`,
      oldTurnId: `turn-${index}`,
      checkpointId: `checkpoint-${index}`,
    });
    expect(lease).not.toBeNull();
    leases.push(lease!);
  }
  saveGoalForChat("web:capacity-overflow");
  expect(latch({
    chatJid: "web:capacity-overflow",
    operationId: "op-overflow",
    oldTurnId: "turn-overflow",
    checkpointId: "checkpoint-overflow",
  })).toBeNull();
  provider.release(leases[0]!);
  expect(consumeGoalDeadlineAgentEndSuppression("web:capacity-0", "turn-0")).toBe(true);
});

test("continuation is suppressed after cancellation, Plan clear, or Goal replacement", () => {
  saveGoal();
  const lease = latch()!;
  provider.markScheduled(lease, { generation: 3 });
  saveGoal({ status: "paused" });
  expect(resolve()).toEqual({ status: "suppress" });
  saveGoal();
  (globalThis as any).__piclaw_planSidebarApi = { getPlan: () => ({ plan: [] }) };
  expect(resolve()).toEqual({ status: "suppress" });
  saveGoal({ goal_id: "goal-new" });
  expect(resolve()).toEqual({ status: "suppress" });
});

test("scheduled checkpoints are bound to the Goal lifecycle generation", () => {
  saveGoal();
  const lease = latch()!;
  expect(lease.lifecycleGeneration).toBe(7);
  provider.markScheduled(lease, { generation: 3 });
  expect((store.get("goal", "thread-goal", "chat", chatJid) as any).deadline_checkpoint).toMatchObject({
    lifecycle_generation: 7,
  });

  const stale = structuredClone(store.get("goal", "thread-goal", "chat", chatJid) as any);
  saveGoal({ ...stale, status: "paused", lifecycle_generation: 8 });
  saveGoal({ ...stale, status: "active", lifecycle_generation: 9 });
  expect(resolve()).toEqual({ status: "suppress" });
});

test("terminal reactivation cannot revive a checkpoint from an older lifecycle", () => {
  for (const terminal of ["complete", "stopped"] as const) {
    saveGoal();
    const lease = latch()!;
    provider.markScheduled(lease, { generation: 3 });
    const stale = structuredClone(store.get("goal", "thread-goal", "chat", chatJid) as any);
    saveGoal({ ...stale, status: terminal, lifecycle_generation: 8 });
    expect(provider.revalidate(lease).action).toBe("suppress");
    saveGoal({ ...stale, status: "active", lifecycle_generation: 9 });
    expect(resolve()).toEqual({ status: "suppress" });
    provider.release(lease);
    resetGoalDeadlineCheckpointForTests();
  }
});

test("ordinary saves preserve lifecycle identity and same claimed-successor retry", () => {
  saveGoal();
  const lease = latch()!;
  provider.markScheduled(lease, { generation: 3 });
  const scheduled = structuredClone(store.get("goal", "thread-goal", "chat", chatJid) as any);
  saveGoal({ ...scheduled, tokens_used: 250, lifecycle_generation: 7 });
  expect(resolve().status).toBe("continue");
  expect(resolve().status).toBe("continue");
  expect((store.get("goal", "thread-goal", "chat", chatJid) as any)).toMatchObject({
    lifecycle_generation: 7,
    tokens_used: 250,
    deadline_checkpoint: { lifecycle_generation: 7, status: "claimed" },
  });
});

test("continuation expiry is inclusive and invalid or implausibly future clocks fail closed", () => {
  const now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    saveGoal();
    const lease = latch()!;
    expect(provider.revalidate({ ...lease, expiresAt: new Date(now).toISOString() }).action).toBe("suppress");
    expect(provider.revalidate({ ...lease, expiresAt: "not-a-clock" }).action).toBe("suppress");
    provider.markScheduled(lease, { generation: 3 });
    const scheduled = structuredClone(store.get("goal", "thread-goal", "chat", chatJid) as any);

    saveGoal({ ...scheduled, deadline_checkpoint: { ...scheduled.deadline_checkpoint, expires_at: new Date(now).toISOString() } });
    expect(resolve()).toEqual({ status: "suppress" });

    saveGoal({ ...scheduled, deadline_checkpoint: { ...scheduled.deadline_checkpoint, expires_at: "not-a-clock" } });
    expect(resolve()).toEqual({ status: "suppress" });

    saveGoal({ ...scheduled, deadline_checkpoint: { ...scheduled.deadline_checkpoint, expires_at: new Date(now + 86_400_000).toISOString() } });
    expect(resolve()).toEqual({ status: "suppress" });
  } finally {
    Date.now = originalNow;
  }
});

test("invalid latch identities and unsafe numeric ownership fields fail closed", () => {
  saveGoal();
  for (const overrides of [
    { chatJid: "" },
    { operationId: " " },
    { oldTurnId: "" },
    { checkpointId: "\n" },
    { operationId: "x".repeat(513) },
    { sourceSeq: Number.NaN },
    { sourceSeq: Number.MAX_SAFE_INTEGER + 1 },
    { operationGeneration: -1 },
    { operationGeneration: 1.5 },
  ]) {
    expect(latch(overrides)).toBeNull();
  }
});

test("malformed Plan runtime APIs fail closed instead of escaping the provider", () => {
  saveGoal();
  (globalThis as any).__piclaw_planSidebarApi = { getPlan: () => { throw new Error("plan unavailable"); } };
  expect(() => latch()).not.toThrow();
  expect(latch()).toBeNull();
});

test("unexpired persisted checkpoint evidence survives restart and blocks replacement", () => {
  saveGoal();
  const lease = latch()!;
  provider.markScheduled(lease, { generation: 3 });
  const scheduled = structuredClone(store.get("goal", "thread-goal", "chat", chatJid) as any);
  resetGoalDeadlineCheckpointForTests();
  expect(latch()).toBeNull();
  expect(store.get("goal", "thread-goal", "chat", chatJid)).toEqual(scheduled);
});

test("expired and malformed persisted checkpoint evidence is cleared at safe invalidation", () => {
  const now = Date.now();
  const validCheckpoint = {
    checkpoint_id: "checkpoint-1",
    operation_id: "op-1",
    source_seq: 41,
    operation_generation: 2,
    continuation_generation: 3,
    lifecycle_generation: 7,
    old_turn_id: "turn-1",
    expires_at: new Date(now + 60_000).toISOString(),
    status: "scheduled",
  };
  const invalidPatches = [
    { expires_at: new Date(now).toISOString() },
    { expires_at: "not-a-clock" },
    { expires_at: ` ${validCheckpoint.expires_at}` },
    { expires_at: new Date(now + 86_400_000).toISOString() },
    { checkpoint_id: " " },
    { operation_id: "" },
    { old_turn_id: "\n" },
    { checkpoint_id: "x".repeat(513) },
    { source_seq: Number.NaN },
    { source_seq: Number.MAX_SAFE_INTEGER + 1 },
    { operation_generation: -1 },
    { operation_generation: 1.5 },
    { continuation_generation: 0 },
    { continuation_generation: Number.POSITIVE_INFINITY },
    { lifecycle_generation: Number.MAX_SAFE_INTEGER + 1 },
    { status: "unknown" },
  ];

  for (const patch of invalidPatches) {
    saveGoal({ deadline_checkpoint: { ...validCheckpoint, ...patch } });
    expect(resolve()).toEqual({ status: "suppress" });
    expect((store.get("goal", "thread-goal", "chat", chatJid) as any).deadline_checkpoint).toBeNull();
  }
});

test("malformed persisted Goal lifecycle generations cannot latch or resolve", () => {
  for (const lifecycle_generation of [Number.NaN, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    saveGoal({ lifecycle_generation });
    expect(latch()).toBeNull();
    expect(resolve()).toEqual({ status: "suppress" });
  }
});

test("expired exact-turn suppression does not affect a newer turn", () => {
  const now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    saveGoal();
    const expiredLease = latch()!;
    provider.release(expiredLease);
    Date.now = () => now + 6 * 60_000;
    expect(consumeGoalDeadlineAgentEndSuppression(chatJid, "turn-1")).toBe(false);

    saveGoal();
    const currentLease = latch({ oldTurnId: "turn-2", checkpointId: "checkpoint-2" })!;
    provider.release(currentLease);
    expect(consumeGoalDeadlineAgentEndSuppression(chatJid, "turn-1")).toBe(false);
    expect(consumeGoalDeadlineAgentEndSuppression(chatJid, "turn-2")).toBe(true);
  } finally {
    Date.now = originalNow;
  }
});

test("invalid or far-future deadline clocks do not create a latch", () => {
  saveGoal();
  expect(provider.tryLatch({
    chatJid,
    operationId: "op-invalid",
    sourceSeq: 42,
    operationGeneration: 2,
    oldTurnId: "turn-invalid",
    checkpointId: "checkpoint-invalid",
    deadlineAt: "not-a-clock",
  })).toBeNull();
  expect(provider.tryLatch({
    chatJid,
    operationId: "op-future",
    sourceSeq: 43,
    operationGeneration: 2,
    oldTurnId: "turn-future",
    checkpointId: "checkpoint-future",
    deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
  })).toBeNull();
  expect(provider.tryLatch({
    chatJid,
    operationId: "op-stale",
    sourceSeq: 44,
    operationGeneration: 2,
    oldTurnId: "turn-stale",
    checkpointId: "checkpoint-stale",
    deadlineAt: new Date(Date.now() - 86_400_000).toISOString(),
  })).toBeNull();

  const originalNow = Date.now;
  const finiteDeadline = new Date(originalNow() + 1_000).toISOString();
  Date.now = () => Number.NaN;
  try {
    expect(() => provider.tryLatch({
      chatJid,
      operationId: "op-nan-clock",
      sourceSeq: 45,
      operationGeneration: 2,
      oldTurnId: "turn-nan-clock",
      checkpointId: "checkpoint-nan-clock",
      deadlineAt: finiteDeadline,
    })).not.toThrow();
    expect(provider.tryLatch({
      chatJid,
      operationId: "op-nan-clock",
      sourceSeq: 45,
      operationGeneration: 2,
      oldTurnId: "turn-nan-clock",
      checkpointId: "checkpoint-nan-clock",
      deadlineAt: finiteDeadline,
    })).toBeNull();
  } finally {
    Date.now = originalNow;
  }
});
