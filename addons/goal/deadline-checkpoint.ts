import { createExtensionStorage } from "./compat/extension-kv.js";

const EXTENSION_ID = "goal";
const GOAL_KEY = "thread-goal";
const MIN_CHECKPOINT_LIFETIME_MS = 60_000;
const MAX_CHECKPOINT_LIFETIME_MS = 5 * 60_000;
const MAX_CHECKPOINT_ID_LENGTH = 512;
const MAX_RUNTIME_SUPPRESSIONS = 1_024;
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
interface PersistedDeadlineCheckpoint {
  checkpoint_id: string;
  operation_id: string;
  source_seq: number;
  operation_generation: number;
  continuation_generation: number;
  lifecycle_generation: number;
  old_turn_id: string;
  expires_at: string;
  status: "scheduled" | "claimed";
}

export interface GoalDeadlineLease {
  chatJid: string;
  goalId: string;
  lifecycleGeneration: number;
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
const agentEndSuppressionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function suppressionKey(chatJid: string, turnId: string): string {
  return `${chatJid}\0${turnId}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function boundedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized === value && normalized.length <= MAX_CHECKPOINT_ID_LENGTH ? normalized : null;
}

function safeInteger(value: unknown, minimum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : null;
}

function lifecycleGeneration(value: unknown): number | null {
  // Goals persisted before lifecycle generations were introduced belong to
  // generation 1. A present but malformed value is not legacy data.
  if (value === undefined || value === null) return 1;
  return safeInteger(value, 1);
}

function checkpointTime(value: unknown): number {
  if (typeof value !== "string" || value.length > 64 || value.trim() !== value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : Number.NaN;
}

function checkpointExpiry(deadlineAt: unknown, now = Date.now()): string | null {
  const deadline = checkpointTime(deadlineAt);
  if (!Number.isFinite(now) || !Number.isFinite(deadline)
    || deadline < now - MAX_CHECKPOINT_LIFETIME_MS
    || deadline > now + MAX_CHECKPOINT_LIFETIME_MS) return null;
  return new Date(Math.min(
    now + MAX_CHECKPOINT_LIFETIME_MS,
    Math.max(now + MIN_CHECKPOINT_LIFETIME_MS, deadline + MIN_CHECKPOINT_LIFETIME_MS),
  )).toISOString();
}

function isCurrentCheckpointExpiry(value: unknown, now = Date.now()): boolean {
  const expiresAt = checkpointTime(value);
  return Number.isFinite(expiresAt)
    && expiresAt > now
    && expiresAt <= now + MAX_CHECKPOINT_LIFETIME_MS;
}

function removeAgentEndSuppression(key: string): void {
  agentEndSuppressions.delete(key);
  const timer = agentEndSuppressionTimers.get(key);
  if (timer) clearTimeout(timer);
  agentEndSuppressionTimers.delete(key);
}

function pruneRuntimeState(now = Date.now()): void {
  for (const [chatJid, lease] of latches) {
    if (!isCurrentCheckpointExpiry(lease.expiresAt, now)) latches.delete(chatJid);
  }
  for (const [key, lease] of agentEndSuppressions) {
    if (!isCurrentCheckpointExpiry(lease.expiresAt, now)) removeAgentEndSuppression(key);
  }
}

function setAgentEndSuppression(lease: GoalDeadlineLease): void {
  const key = suppressionKey(lease.chatJid, lease.oldTurnId);
  removeAgentEndSuppression(key);
  agentEndSuppressions.set(key, lease);
  const delay = Math.max(1, Date.parse(lease.expiresAt) - Date.now() + 1);
  const timer = setTimeout(() => {
    const current = agentEndSuppressions.get(key);
    if (current?.checkpointId === lease.checkpointId) removeAgentEndSuppression(key);
  }, delay);
  (timer as unknown as { unref?: () => void }).unref?.();
  agentEndSuppressionTimers.set(key, timer);
  pruneRuntimeState();
}

function validLeaseIdentity(lease: GoalDeadlineLease): boolean {
  return Boolean(boundedId(lease.chatJid)
    && boundedId(lease.goalId)
    && boundedId(lease.operationId)
    && boundedId(lease.oldTurnId)
    && boundedId(lease.checkpointId)
    && safeInteger(lease.sourceSeq, 1) !== null
    && safeInteger(lease.operationGeneration, 0) !== null
    && safeInteger(lease.lifecycleGeneration, 1) !== null
    && isCurrentCheckpointExpiry(lease.expiresAt));
}

function loadGoal(chatJid: string): PersistedGoal | null {
  const goal = storage().get<PersistedGoal>(GOAL_KEY, "chat", chatJid);
  return goal && boundedId(goal.goal_id) && text(goal.objective) ? goal : null;
}

function normalizePersistedCheckpoint(value: unknown): PersistedDeadlineCheckpoint | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const checkpoint_id = boundedId(candidate.checkpoint_id);
  const operation_id = boundedId(candidate.operation_id);
  const old_turn_id = boundedId(candidate.old_turn_id);
  const source_seq = safeInteger(candidate.source_seq, 1);
  const operation_generation = safeInteger(candidate.operation_generation, 0);
  const continuation_generation = safeInteger(candidate.continuation_generation, 1);
  const lifecycle_generation = safeInteger(candidate.lifecycle_generation, 1);
  const expires_at = Number.isFinite(checkpointTime(candidate.expires_at))
    ? candidate.expires_at as string
    : null;
  const status = candidate.status === "scheduled" || candidate.status === "claimed" ? candidate.status : null;
  if (!checkpoint_id || !operation_id || !old_turn_id || source_seq === null || operation_generation === null
    || continuation_generation === null || lifecycle_generation === null || !expires_at || !status) return null;
  return {
    checkpoint_id,
    operation_id,
    source_seq,
    operation_generation,
    continuation_generation,
    lifecycle_generation,
    old_turn_id,
    expires_at,
    status,
  };
}

function clearPersistedCheckpoint(goal: PersistedGoal, chatJid: string): PersistedGoal {
  if (goal.deadline_checkpoint === null || goal.deadline_checkpoint === undefined) return goal;
  const next = { ...goal, deadline_checkpoint: null };
  storage().set(GOAL_KEY, next, "chat", chatJid);
  return next;
}

function currentPlan(chatJid: string): { items: PlanItem[]; fingerprint: string } | null {
  try {
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
  } catch {
    return null;
  }
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
    const now = Date.now();
    const chatJid = boundedId(input.chatJid);
    const operationId = boundedId(input.operationId);
    const oldTurnId = boundedId(input.oldTurnId);
    const checkpointId = boundedId(input.checkpointId);
    const sourceSeq = safeInteger(input.sourceSeq, 1);
    const operationGeneration = safeInteger(input.operationGeneration, 0);
    const expiresAt = checkpointExpiry(input.deadlineAt, now);
    if (!chatJid || !operationId || !oldTurnId || !checkpointId || sourceSeq === null
      || operationGeneration === null || !expiresAt) return null;

    pruneRuntimeState(now);
    const suppression = suppressionKey(chatJid, oldTurnId);
    if (latches.has(chatJid) || agentEndSuppressions.has(suppression)
      || latches.size >= MAX_RUNTIME_SUPPRESSIONS
      || agentEndSuppressions.size >= MAX_RUNTIME_SUPPRESSIONS) return null;
    let goal = loadGoal(chatJid);
    const goalId = boundedId(goal?.goal_id);
    const goalLifecycleGeneration = lifecycleGeneration(goal?.lifecycle_generation);
    if (!goal || !goalId || goalLifecycleGeneration === null || text(goal.status) !== "active") return null;

    if (goal.deadline_checkpoint !== undefined && goal.deadline_checkpoint !== null) {
      const persisted = normalizePersistedCheckpoint(goal.deadline_checkpoint);
      if (persisted && persisted.lifecycle_generation === goalLifecycleGeneration
        && isCurrentCheckpointExpiry(persisted.expires_at, now)) return null;
      goal = clearPersistedCheckpoint(goal, chatJid);
    }

    const plan = currentPlan(chatJid);
    if (!plan) return null;
    const lease: GoalDeadlineLease = {
      chatJid,
      goalId,
      lifecycleGeneration: goalLifecycleGeneration,
      objective: text(goal.objective),
      planFingerprint: plan.fingerprint,
      operationId,
      sourceSeq,
      operationGeneration,
      oldTurnId,
      checkpointId,
      expiresAt,
    };
    latches.set(chatJid, lease);
    setAgentEndSuppression(lease);
    return lease;
  },

  revalidate(lease: GoalDeadlineLease): GoalDeadlineResolution {
    if (!validLeaseIdentity(lease)) {
      return { action: "suppress", goalId: text(lease.goalId), objective: text(lease.objective), planFingerprint: "", visibleText: "" };
    }
    const goal = loadGoal(lease.chatJid);
    const goalId = text(goal?.goal_id);
    const objective = text(goal?.objective);
    const plan = currentPlan(lease.chatJid);
    if (!goal || goalId !== lease.goalId || lifecycleGeneration(goal.lifecycle_generation) !== lease.lifecycleGeneration) {
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
    const continuationGeneration = safeInteger(continuation.generation, 1);
    if (!validLeaseIdentity(lease) || continuationGeneration === null) {
      throw new Error("Invalid Goal deadline checkpoint ownership");
    }
    const goal = loadGoal(lease.chatJid);
    if (!goal || boundedId(goal.goal_id) !== lease.goalId || text(goal.status) !== "active"
      || lifecycleGeneration(goal.lifecycle_generation) !== lease.lifecycleGeneration) {
      throw new Error("Goal changed or checkpoint expired before deadline checkpoint scheduling");
    }
    const persisted = normalizePersistedCheckpoint(goal.deadline_checkpoint);
    if (persisted && isCurrentCheckpointExpiry(persisted.expires_at)) {
      const exactRetry = persisted.checkpoint_id === lease.checkpointId
        && persisted.operation_id === lease.operationId
        && persisted.source_seq === lease.sourceSeq
        && persisted.operation_generation === lease.operationGeneration
        && persisted.continuation_generation === continuationGeneration
        && persisted.lifecycle_generation === lease.lifecycleGeneration
        && persisted.old_turn_id === lease.oldTurnId
        && persisted.expires_at === lease.expiresAt;
      if (!exactRetry) throw new Error("Another Goal deadline checkpoint is still recoverable");
      return;
    }
    storage().set(GOAL_KEY, {
      ...goal,
      deadline_checkpoint: {
        checkpoint_id: lease.checkpointId,
        operation_id: lease.operationId,
        source_seq: lease.sourceSeq,
        operation_generation: lease.operationGeneration,
        continuation_generation: continuationGeneration,
        lifecycle_generation: lease.lifecycleGeneration,
        old_turn_id: lease.oldTurnId,
        expires_at: lease.expiresAt,
        status: "scheduled",
      },
    }, "chat", lease.chatJid);
  },

  release(lease: GoalDeadlineLease): void {
    pruneRuntimeState();
    const current = latches.get(lease.chatJid);
    if (current?.checkpointId === lease.checkpointId) latches.delete(lease.chatJid);
    // Keep the exact-turn one-shot suppression until agent_end consumes it or
    // its bounded timer expires. Persisted checkpoint evidence is independent.
  },

  resolveContinuation(input: { chatJid: string; goalId: string; checkpointId: string; generation: number }): { status: "continue"; content: string } | { status: "suppress" } {
    const chatJid = boundedId(input.chatJid);
    const goalId = boundedId(input.goalId);
    const checkpointId = boundedId(input.checkpointId);
    const generation = safeInteger(input.generation, 1);
    if (!chatJid || !goalId || !checkpointId || generation === null) return { status: "suppress" };

    const goal = loadGoal(chatJid);
    const goalLifecycleGeneration = lifecycleGeneration(goal?.lifecycle_generation);
    if (!goal || boundedId(goal.goal_id) !== goalId || goalLifecycleGeneration === null) return { status: "suppress" };

    const hasCheckpoint = goal.deadline_checkpoint !== undefined && goal.deadline_checkpoint !== null;
    const checkpoint = normalizePersistedCheckpoint(goal.deadline_checkpoint);
    if (text(goal.status) !== "active" || (hasCheckpoint && !checkpoint)
      || (checkpoint && checkpoint.lifecycle_generation !== goalLifecycleGeneration)
      || (checkpoint && !isCurrentCheckpointExpiry(checkpoint.expires_at))) {
      if (hasCheckpoint) clearPersistedCheckpoint(goal, chatJid);
      return { status: "suppress" };
    }
    if (!checkpoint || checkpoint.checkpoint_id !== checkpointId
      || checkpoint.continuation_generation !== generation) return { status: "suppress" };

    const plan = currentPlan(chatJid);
    if (!plan) return { status: "suppress" };
    if (checkpoint.status === "scheduled") {
      storage().set(GOAL_KEY, {
        ...goal,
        deadline_checkpoint: { ...checkpoint, status: "claimed" },
      }, "chat", chatJid);
    }
    return { status: "continue", content: continuationPrompt(goal, text(goal.objective), plan.items) };
  },
};

export function consumeClaimedGoalDeadlineCheckpoint(chatJid: string): boolean {
  const normalizedChatJid = boundedId(chatJid);
  if (!normalizedChatJid) return false;
  const goal = loadGoal(normalizedChatJid);
  if (!goal || goal.deadline_checkpoint === undefined || goal.deadline_checkpoint === null) return false;
  const checkpoint = normalizePersistedCheckpoint(goal.deadline_checkpoint);
  const goalLifecycleGeneration = lifecycleGeneration(goal.lifecycle_generation);
  if (!checkpoint || goalLifecycleGeneration === null
    || checkpoint.lifecycle_generation !== goalLifecycleGeneration
    || !isCurrentCheckpointExpiry(checkpoint.expires_at)) {
    clearPersistedCheckpoint(goal, normalizedChatJid);
    return false;
  }
  if (checkpoint.status !== "claimed") return false;
  clearPersistedCheckpoint(goal, normalizedChatJid);
  return true;
}

export function consumeGoalDeadlineAgentEndSuppression(chatJid: string, turnId: string): boolean {
  const normalizedChatJid = boundedId(chatJid);
  const normalizedTurnId = boundedId(turnId);
  if (!normalizedChatJid || !normalizedTurnId) return false;
  pruneRuntimeState();
  const key = suppressionKey(normalizedChatJid, normalizedTurnId);
  const lease = agentEndSuppressions.get(key);
  if (!lease) return false;
  removeAgentEndSuppression(key);
  const current = latches.get(normalizedChatJid);
  if (current?.checkpointId === lease.checkpointId) latches.delete(normalizedChatJid);
  return isCurrentCheckpointExpiry(lease.expiresAt);
}

export function resetGoalDeadlineCheckpointForTests(): void {
  latches.clear();
  for (const key of [...agentEndSuppressionTimers.keys()]) removeAgentEndSuppression(key);
  agentEndSuppressions.clear();
  storageInstance = null;
}
