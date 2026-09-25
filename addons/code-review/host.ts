import type {
  ReviewIdentity,
  LocalContextReference,
  LocalTarget,
} from "./contracts.js";
import { ReviewError } from "./contracts.js";
/** Structural copy of the proposed public core v1 contract. No private runtime imports. */
export interface HostTarget {
  chatJid: string;
  incarnation: string;
  label: string;
  agentName: string;
  active: boolean;
}
export interface LocalContext {
  version: 1;
  accessMode: "single-user";
  ownerId: string;
  actorId: string;
  kind: "operator" | "agent";
  workspaceRoot: string;
  workspaceId: string;
  chatJid?: string;
  chatIncarnation?: string;
  reference?: LocalContextReference;
  listTargets(): Promise<HostTarget[]>;
  resolveTarget(input: {
    chatJid?: string;
    agentName?: string;
    incarnation?: string;
  }): Promise<HostTarget | null>;
  enqueue(input: {
    target: { chatJid: string; incarnation: string };
    content: string;
    mode: "queue";
    reference?: LocalContextReference;
  }): Promise<{ status: "accepted"; rowId: number | null }>;
}
export interface Runtime {
  localContext?: {
    version: 1;
    getRequestContext(req: Request): LocalContext | null;
    getToolContext(): LocalContext | null;
  };
  messaging?: { version: number; getAddonDataDir(id: string): string };
  lifecycle?: {
    version: number;
    onShutdown(callback: () => void | Promise<void>): () => void;
  };
}
export function getRuntime(): Runtime | undefined {
  return (globalThis as Record<string, any>).__piclaw_runtime;
}
export function requireContext(
  value: LocalContext | null | undefined,
): LocalContext {
  if (
    !value ||
    value.version !== 1 ||
    value.accessMode !== "single-user" ||
    !value.ownerId ||
    !value.actorId ||
    !value.workspaceRoot ||
    !value.workspaceId ||
    !["operator", "agent"].includes(value.kind)
  )
    throw new ReviewError(
      "context_unavailable",
      "Code Review requires a guarded operator action or explicit local review dispatch on a compatible single-user host. Use Send to agent to establish agent scope.",
      403,
    );
  if (value.kind === "agent" && (!value.chatJid || !value.chatIncarnation))
    throw new ReviewError(
      "context_unavailable",
      "Verified agent chat identity is unavailable.",
      403,
    );
  return value;
}
export function storeIdentity(ctx: LocalContext): ReviewIdentity {
  requireContext(ctx);
  return {
    ownerId: ctx.ownerId,
    actorId: ctx.actorId,
    kind: ctx.kind,
    workspaceId: ctx.workspaceId,
    chatId: ctx.chatJid,
    chatIncarnation: ctx.chatIncarnation,
    reference: ctx.reference,
  };
}
export function storeTarget(value: HostTarget): LocalTarget {
  return {
    chatId: value.chatJid,
    incarnation: value.incarnation,
    label: value.label,
  };
}
export async function resolveHostTarget(
  ctx: LocalContext,
  value: { chatId?: string; agentName?: string; incarnation?: string },
): Promise<LocalTarget> {
  const result = await ctx.resolveTarget({
    ...(value.chatId ? { chatJid: value.chatId } : {}),
    ...(value.agentName ? { agentName: value.agentName } : {}),
    ...(value.incarnation ? { incarnation: value.incarnation } : {}),
  });
  if (!result)
    throw new ReviewError(
      "target_unavailable",
      "Select a currently authorised local agent; old aliases are not rebound automatically.",
      409,
    );
  return storeTarget(result);
}
