import { getRuntime, requireContext } from "./host.js";
import { reviewAction } from "./runtime.js";
const ACTIONS = [
  "dispatches",
  "dispatch",
  "thread",
  "threads",
  "reply",
  "edit",
  "deleteMessage",
  "resolve",
  "work",
] as const;
export default function codeReview(pi: any) {
  pi.registerTool({
    name: "code_review",
    label: "Code Review",
    description:
      "Read assigned saved-code review threads and queued batches; publish replies, progress and evidence-backed resolutions. Requires an explicit local review dispatch; use Send to agent to establish scope. Does not edit source. Read the latest thread and assignment epoch before acting. Results are bounded; paginate thread messages and lists.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        reviewId: { type: "string" },
        threadId: { type: "string" },
        dispatchId: { type: "string" },
        messageId: { type: "string" },
        requestId: { type: "string" },
        expectedVersion: { type: "integer" },
        assignmentEpoch: { type: "integer" },
        body: { type: "string" },
        explanation: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        fileId: { type: "string" },
        state: {
          type: "string",
          enum: [
            "in_progress",
            "waiting_user",
            "blocked",
            "failed",
            "completed",
            "superseded",
          ],
        },
        itemVersion: { type: "integer" },
        threadVersion: { type: "integer" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        after: { type: "string" },
        confirm: { type: "boolean" },
      },
    },
    async execute(_id: string, params: any) {
      if (!ACTIONS.includes(params.action))
        throw Error("Unsupported Code Review tool action.");
      const runtime = getRuntime();
      if (runtime?.localContext?.version !== 1)
        throw Error("Code Review requires localContext v1 on the host.");
      const context = requireContext(runtime.localContext.getToolContext());
      const result = await reviewAction(context, params.action, params);
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > 50_000)
        throw Error(
          "Review result exceeds tool output limit; request a smaller page.",
        );
      return { content: [{ type: "text", text }], details: result };
    },
  });
  pi.on("resources_discover", () => ({
    skillPaths: [`${import.meta.dir}/skills/code-review`],
  }));
}
