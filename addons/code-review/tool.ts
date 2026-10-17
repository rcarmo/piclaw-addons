import { getRuntime, requireContext } from "./host.js";
import { reviewAction, runCodeReviewRead } from "./runtime.js";
import type { ReviewService } from "./dispatch.js";
import type { ReviewIdentity } from "./contracts.js";

export const codeReviewToolDeclaration = {
  name: "code_review",
  label: "Code Review",
  description:
    "Read assigned saved-code review threads and queued batches; publish replies, progress and evidence-backed resolutions. Requires an explicit local review dispatch; use Send to agent to establish scope. Does not edit source. Read the latest thread and assignment epoch before acting. Results are bounded; paginate thread messages and lists.",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["dispatches", "dispatch", "thread", "threads", "reply", "edit", "deleteMessage", "resolve", "work"] },
      reviewId: { type: "string" }, threadId: { type: "string" }, dispatchId: { type: "string" },
      messageId: { type: "string" }, requestId: { type: "string" },
      expectedVersion: { type: "integer" }, assignmentEpoch: { type: "integer" },
      body: { type: "string" }, explanation: { type: "string" },
      evidence: { type: "array", items: { type: "string" } }, fileId: { type: "string" },
      state: { type: "string", enum: ["in_progress", "waiting_user", "blocked", "failed", "completed", "superseded"] },
      itemVersion: { type: "integer" }, threadVersion: { type: "integer" },
      limit: { type: "integer", minimum: 1, maximum: 100 }, after: { type: "string" }, confirm: { type: "boolean" },
    },
  },
};
export interface CodeReviewReadAuthority {
  service: ReviewService;
  identity: ReviewIdentity;
  workspaceRoot: string;
  assertCurrent(): void;
}
export interface CodeReviewReadPolicy {
  resolve(): Promise<CodeReviewReadAuthority>;
}
/** Public factory. A native caller supplies invocation-local authority, not an
 * ExtensionContext/AgentSession. No ambient host context is used in this mode. */
export function createCodeReviewTool(policy?: CodeReviewReadPolicy) {
  return {
    ...codeReviewToolDeclaration,
    async execute(_id: string, params: any) {
      if (!codeReviewToolDeclaration.parameters.properties.action.enum.includes(params.action))
        throw Error("Unsupported Code Review tool action.");
      let result: unknown;
      if (policy) {
        if (!["dispatches", "dispatch", "threads", "thread"].includes(params.action) ||
          Object.keys(params).some(key => !["action", "reviewId", "dispatchId", "threadId", "limit", "after"].includes(key)))
          throw Error("Code Review writes unavailable while durable worker unqualified.");
        if (["reviewId", "dispatchId", "threadId", "after"].some(key => params[key] !== undefined && typeof params[key] !== "string") ||
          (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100)) ||
          (params.action === "thread" && (typeof params.threadId !== "string" || (params.after !== undefined && (!/^\d+$/.test(params.after) || !Number.isSafeInteger(Number(params.after)))))))
          throw Error("Invalid Code Review read arguments.");
        const authority = await policy.resolve();
        authority.assertCurrent();
        if (authority.identity.kind !== "agent") throw Error("Code Review requires assigned agent authority.");
        result = await runCodeReviewRead(authority.service, authority.identity, params.action, params, authority.workspaceRoot, authority.assertCurrent);
        authority.assertCurrent();
      } else {
        const runtime = getRuntime();
        if (runtime?.localContext?.version !== 1) throw Error("Code Review requires localContext v1 on the host.");
        result = await reviewAction(requireContext(runtime.localContext.getToolContext()), params.action, params);
      }
      const text = JSON.stringify(result);
      if (text === undefined || Buffer.byteLength(text) > 50_000)
        throw Error("Review result exceeds tool output limit; request a smaller page.");
      return { content: [{ type: "text" as const, text }], details: result };
    },
  };
}
