import { createExtensionStorage } from "./compat/extension-kv.js";

const EXTENSION_ID = "goal";
const GOAL_KEY = "thread-goal";
let storageInstance: ReturnType<typeof createExtensionStorage> | null = null;
const storage = () => storageInstance ??= createExtensionStorage(EXTENSION_ID);

interface PersistedGoal {
  goal_id?: unknown;
  chat_jid?: unknown;
  objective?: unknown;
  status?: unknown;
  token_budget?: unknown;
  tokens_used?: unknown;
  completion_summary?: unknown;
  completion_evidence?: unknown;
  stop_summary?: unknown;
  stop_evidence?: unknown;
  deadline_checkpoint?: unknown;
  [key: string]: unknown;
}

interface PlanItem { step: string; status: "pending" | "in_progress" | "completed" }
interface PlanApi { getPlan(chatJid?: unknown): { plan?: unknown } }

export interface GoalDeadlineLease {
  chatJid: string;
  goalId: string;
  objective: string;
  planFingerprint: string;
  operationId: string;
  sourceSeq: number;
  operationGeneration: number;
  oldTurnId: string;
  checkpointId: string;
  expiresAt: string;
}

export interface GoalDeadlineResolution {
  action: "continue" | "complete" | "stop" | "suppress";
  goalId: string;
  objective: string;
  planFingerprint: string;
  visibleText: string;
  continuationText?: string;
}

// Piclaw serializes prompt mutations through one lane per chat, so only one
// Goal deadline latch can own that chat at a time. Agent-end suppression is
// keyed separately by exact turn identity: release may precede a delayed
// agent_end when abort settlement fails, and that old event must never restart
// the legacy Goal loop or consume suppression for a newer turn.
const latches = new Map<string, GoalDeadlineLease>();
const agentEndSuppressions = new Map<string, GoalDeadlineLease>();

function suppressionKey(chatJid: string, turnId: string): string {
  return `${chatJid}\0${turnId}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function loadGoal(chatJid: string): PersistedGoal | null {
  const goal = storage().get<PersistedGoal>(GOAL_KEY, "chat", chatJid);
  return goal && text(goal.goal_id) && text(goal.objective) ? goal : null;
}

function currentPlan(chatJid: string): { items: PlanItem[]; fingerprint: string } | null {
  const candidate = (globalThis as Record<string, unknown>).__piclaw_planSidebarApi;
  if (!candidate || typeof candidate !== "object" || typeof (candidate as PlanApi).getPlan !== "function") return null;
  const raw = (candidate as PlanApi).getPlan(chatJid)?.plan;
  const items = Array.isArray(raw) ? raw.filter((item): item is PlanItem => {
    if (!item || typeof item !== "object") return false;
    const value = item as { step?: unknown; status?: unknown };
    return typeof value.step === "string" && Boolean(value.step.trim())
      && (value.status === "pending" || value.status === "in_progress" || value.status === "completed");
  }).map((item) => ({ step: item.step.trim(), status: item.status })) : [];
  if (items.length === 0) return null;
  return { items, fingerprint: JSON.stringify(items.map((item) => [item.step, item.status])) };
}

function continuationPrompt(goal: PersistedGoal, objective: string, plan: PlanItem[]): string {
  const tokenBudget = typeof goal.token_budget === "number" ? goal.token_budget : null;
  const tokensUsed = typeof goal.tokens_used === "number" ? goal.tokens_used : 0;
  return [
    "Continue working toward the active persisted thread goal from its checkpoint.",
    "Use ordinary execution tools and inspect current state before changing anything.",
    "Do not repeat completed plan work, narrow the objective, or claim completion without evidence.",
    "",
    "<objective>",
    objective,
    "</objective>",
    "",
    "Current persisted plan:",
    ...plan.map((item) => `- [${item.status === "completed" ? "x" : item.status === "in_progress" ? "-" : " "}] ${item.step}`),
    "",
    `Tokens used: ${tokensUsed}`,
    `Token budget: ${tokenBudget ?? "none"}`,
    "",
    "Continue with the next incomplete plan item. Keep the Plan Sidebar current. Use goal_complete only after the full objective is verified; use goal_stop only when autonomous work must stop.",
  ].join("\n");
}

export const goalDeadlineCheckpointProvider = {
  tryLatch(input: {
    chatJid: string;
    operationId: string;
    sourceSeq: number;
    operationGeneration: number;
    oldTurnId: string;
    checkpointId: string;
    deadlineAt: string;
  }): GoalDeadlineLease | null {
    for (const [key, suppression] of agentEndSuppressions) {
      if (Date.parse(suppression.expiresAt) <= Date.now()) agentEndSuppressions.delete(key);
    }
    const existing = latches.get(input.chatJid);
    if (existing && Date.parse(existing.expiresAt) > Date.now()) return null;
    if (existing) latches.delete(input.chatJid);
    const goal = loadGoal(input.chatJid);
    const plan = currentPlan(input.chatJid);
    if (!goal || text(goal.status) !== "active" || !plan) return null;
    const lease: GoalDeadlineLease = {
      chatJid: input.chatJid,
      goalId: text(goal.goal_id),
      objective: text(goal.objective),
      planFingerprint: plan.fingerprint,
      operationId: input.operationId,
      sourceSeq: input.sourceSeq,
      operationGeneration: input.operationGeneration,
      oldTurnId: input.oldTurnId,
      checkpointId: input.checkpointId,
      expiresAt: new Date(Math.max(Date.now() + 60_000, Date.parse(input.deadlineAt) + 60_000)).toISOString(),
    };
    latches.set(input.chatJid, lease);
    agentEndSuppressions.set(suppressionKey(input.chatJid, input.oldTurnId), lease);
    return lease;
  },

  revalidate(lease: GoalDeadlineLease): GoalDeadlineResolution {
    const goal = loadGoal(lease.chatJid);
    const goalId = text(goal?.goal_id);
    const objective = text(goal?.objective);
    const plan = currentPlan(lease.chatJid);
    if (!goal || goalId !== lease.goalId) {
      return { action: "suppress", goalId: lease.goalId, objective: lease.objective, planFingerprint: "", visibleText: "" };
    }
    if (goal.status === "complete") {
      const evidence = stringList(goal.completion_evidence);
      return {
        action: "complete", goalId, objective, planFingerprint: plan?.fingerprint ?? "",
        visibleText: [`Goal completed: ${text(goal.completion_summary) || objective}`, ...evidence.map((item) => `- ${item}`)].join("\n"),
      };
    }
    if (goal.status === "stopped") {
      const evidence = stringList(goal.stop_evidence);
      return {
        action: "stop", goalId, objective, planFingerprint: plan?.fingerprint ?? "",
        visibleText: [`Goal stopped: ${text(goal.stop_summary) || objective}`, ...evidence.map((item) => `- ${item}`)].join("\n"),
      };
    }
    if (goal.status !== "active" || !plan || !objective) {
      return { action: "suppress", goalId, objective, planFingerprint: plan?.fingerprint ?? "", visibleText: "" };
    }
    return {
      action: "continue",
      goalId,
      objective,
      planFingerprint: plan.fingerprint,
      visibleText: "Goal progress checkpointed before the turn deadline. Continuing automatically.",
      continuationText: continuationPrompt(goal, objective, plan.items),
    };
  },

  markScheduled(lease: GoalDeadlineLease, continuation: { generation: number }): void {
    if (!Number.isSafeInteger(continuation.generation) || continuation.generation < 1) {
      throw new Error("Invalid Goal deadline continuation generation");
    }
    const goal = loadGoal(lease.chatJid);
    if (!goal || text(goal.goal_id) !== lease.goalId || text(goal.status) !== "active") {
      throw new Error("Goal changed before deadline checkpoint scheduling");
    }
    storage().set(GOAL_KEY, {
      ...goal,
      deadline_checkpoint: {
        checkpoint_id: lease.checkpointId,
        operation_id: lease.operationId,
        source_seq: lease.sourceSeq,
        operation_generation: lease.operationGeneration,
        continuation_generation: continuation.generation,
        old_turn_id: lease.oldTurnId,
        expires_at: lease.expiresAt,
        status: "scheduled",
      },
    }, "chat", lease.chatJid);
  },

  release(lease: GoalDeadlineLease): void {
    const current = latches.get(lease.chatJid);
    if (current?.checkpointId === lease.checkpointId) latches.delete(lease.chatJid);
    // Keep the exact-turn one-shot suppression until agent_end consumes it or
    // the lease expires. This is safe for later turns because their turn IDs
    // cannot match this key.
  },

  resolveContinuation(input: { chatJid: string; goalId: string; checkpointId: string; generation: number }): { status: "continue"; content: string } | { status: "suppress" } {
    const goal = loadGoal(input.chatJid);
    const plan = currentPlan(input.chatJid);
    if (!goal || text(goal.goal_id) !== input.goalId || text(goal.status) !== "active" || !plan) return { status: "suppress" };
    const checkpoint = goal.deadline_checkpoint && typeof goal.deadline_checkpoint === "object"
      ? goal.deadline_checkpoint as { checkpoint_id?: unknown; continuation_generation?: unknown; status?: unknown }
      : null;
    if (!checkpoint || text(checkpoint.checkpoint_id) !== input.checkpointId
      || checkpoint.continuation_generation !== input.generation) return { status: "suppress" };
    storage().set(GOAL_KEY, {
      ...goal,
      deadline_checkpoint: { ...checkpoint, status: "claimed" },
    }, "chat", input.chatJid);
    return { status: "continue", content: continuationPrompt(goal, text(goal.objective), plan.items) };
  },
};

export function consumeGoalDeadlineAgentEndSuppression(chatJid: string, turnId: string): boolean {
  const normalizedTurnId = text(turnId);
  if (!normalizedTurnId) return false;
  const key = suppressionKey(chatJid, normalizedTurnId);
  const lease = agentEndSuppressions.get(key);
  if (!lease) return false;
  agentEndSuppressions.delete(key);
  const current = latches.get(chatJid);
  if (current?.checkpointId === lease.checkpointId) latches.delete(chatJid);
  return Date.parse(lease.expiresAt) > Date.now();
}

export function resetGoalDeadlineCheckpointForTests(): void {
  latches.clear();
  agentEndSuppressions.clear();
  storageInstance = null;
}
