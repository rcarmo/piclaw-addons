import { getRuntime, requireContext } from "./host.js";
import { reviewAction, runCodeReviewRead, runCodeReviewMutation } from "./runtime.js";
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
  write?<T>(body: () => T): T;
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
      if (!params || typeof params !== "object" || (Object.getPrototypeOf(params) !== Object.prototype && Object.getPrototypeOf(params) !== null))
        throw Error("Plain Code Review arguments required.");
      params = structuredClone(params);
      if (!codeReviewToolDeclaration.parameters.properties.action.enum.includes(params.action))
        throw Error("Unsupported Code Review tool action.");
      let result: unknown;
      if (policy) {
        const writing = ["reply", "edit", "deleteMessage", "resolve"].includes(params.action);
        const keys = writing ? Object.keys(codeReviewToolDeclaration.parameters.properties) : ["action", "reviewId", "dispatchId", "threadId", "limit", "after"];
        if ((!writing && !["dispatches", "dispatch", "threads", "thread"].includes(params.action)) ||
          Object.keys(params).some(key => !keys.includes(key)))
          throw Error("Code Review action unavailable while durable worker unqualified.");
        if (!writing && (["reviewId", "dispatchId", "threadId", "after"].some(key => params[key] !== undefined && typeof params[key] !== "string") ||
          (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100)) ||
          (params.action === "thread" && (typeof params.threadId !== "string" || (params.after !== undefined && (!/^\d+$/.test(params.after) || !Number.isSafeInteger(Number(params.after))))))))
          throw Error("Invalid Code Review read arguments.");
        const authority = await policy.resolve();
        authority.assertCurrent();
        if (authority.identity.kind !== "agent") throw Error("Code Review requires assigned agent authority.");
        if (writing) {
          if (!authority.write) throw Error("Code Review mutation authority unavailable.");
          result = authority.write(() => {
            authority.assertCurrent();
            const value = runCodeReviewMutation(authority.service, authority.identity, params.action, params);
            authority.assertCurrent();
            return value;
          });
        } else result = await runCodeReviewRead(authority.service, authority.identity, params.action, params, authority.workspaceRoot, authority.assertCurrent);
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
