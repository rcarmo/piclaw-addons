import { join } from "node:path";
import { ReviewService, type DispatchInput } from "./dispatch.js";
import { SourceReader, type CaptureRequest } from "./source.js";
import { compareSource, highlightSource } from "./render-source.js";
import { renderComment } from "./markdown.js";
import {
  getRuntime,
  requireContext,
  resolveHostTarget,
  storeIdentity,
  type LocalContext,
} from "./host.js";
import { LIMITS, ReviewError, type Mutation } from "./contracts.js";
import { operator, pageSize } from "./validation.js";
interface ServiceState {
  service: ReviewService;
  close: () => void;
}
const states = new Map<string, ServiceState>();
export function reviewService(): ReviewService {
  const runtime = getRuntime();
  if (runtime?.localContext?.version !== 1 || runtime.messaging?.version !== 1)
    throw new ReviewError(
      "host_unavailable",
      "Code Review needs Piclaw localContext v1 and scoped add-on data support.",
      503,
    );
  const dir = runtime.messaging.getAddonDataDir("code-review");
  const existing = states.get(dir);
  if (existing) return existing.service;
  const service = new ReviewService(join(dir, "reviews.db"));
  service.recoverInterrupted();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    service.close();
    states.delete(dir);
  };
  states.set(dir, { service, close });
  runtime.lifecycle?.onShutdown(close);
  return service;
}
export function closeReviewServices() {
  for (const state of [...states.values()]) state.close();
}
function record(input: unknown): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ReviewError("invalid_input", "An object payload is required.");
  return input as Record<string, any>;
}
function mutation(body: Record<string, any>): Mutation {
  return { requestId: body.requestId, expectedVersion: body.expectedVersion };
}
function freshBody(input: Record<string, any>) {
  for (const key of [
    "ownerId",
    "actorId",
    "kind",
    "workspaceRoot",
    "workspaceId",
  ])
    if (key in input)
      throw new ReviewError(
        "forbidden",
        "Authority fields cannot be supplied by the client.",
        403,
      );
}
async function verifyAgentBinding(
  ctx: LocalContext,
  service: ReviewService,
  threadId?: string,
) {
  if (ctx.kind !== "agent") return;
  const target = await ctx.resolveTarget({
    chatJid: ctx.chatJid,
    incarnation: ctx.chatIncarnation,
  });
  if (!target)
    throw new ReviewError(
      "target_unavailable",
      "Agent chat no longer exists.",
      403,
    );
  if (threadId) service.getThread(storeIdentity(ctx), threadId, 0, 1);
}
/** Browser/API and tool callers use exactly the same scoped domain operations. */
export async function reviewAction(
  ctxValue: LocalContext | null,
  action: string,
  input: unknown,
  providedService?: ReviewService,
): Promise<unknown> {
  const ctx = requireContext(ctxValue),
    who = storeIdentity(ctx),
    body = record(input);
  freshBody(body);
  // Flat fields are informational; the method revalidates the host-owned active scope on every action.
  await ctx.listTargets();
  const service = providedService ?? reviewService();
  await verifyAgentBinding(
    ctx,
    service,
    action === "work" ? undefined : body.threadId,
  );
  const recheck = async () => {
    await ctx.listTargets();
  };
  const reader = () => new SourceReader(ctx.workspaceRoot, ctx.workspaceId);
  switch (action) {
    case "targets":
      operator(who);
      return ctx.listTargets();
    case "list":
      return service.listReviews(who, body.limit, body.after);
    case "create": {
      operator(who);
      const target = await resolveHostTarget(ctx, body.target ?? {});
      const capture = await reader().capture({
        path: body.path,
        mode: body.mode ?? "source",
        commit: body.commit,
        parent: body.parent,
        includeUntracked: body.includeUntracked === true,
      });
      await recheck();
      return service.createFromCapture(
        who,
        { title: body.title || body.path, focusPath: body.path, target },
        capture,
        mutation(body),
      );
    }
    case "review":
      return service.getReview(who, body.reviewId);
    case "target": {
      const selected = await resolveHostTarget(ctx, body.target ?? {});
      return service.setTarget(who, body.reviewId, selected, mutation(body));
    }
    case "capture": {
      operator(who);
      const captured = await reader().capture(body.source as CaptureRequest);
      await recheck();
      return service.capture(who, body.reviewId, captured, mutation(body));
    }
    case "addFile": {
      operator(who);
      const captured = await reader().capture({
        path: body.path,
        mode: "source",
      });
      await recheck();
      return service.addFile(
        who,
        body.reviewId,
        body.snapshotId,
        captured,
        mutation(body),
      );
    }
    case "snapshots":
      return service.listSnapshots(who, body.reviewId, body.limit);
    case "files":
      return service.snapshotFiles(who, body.reviewId, body.snapshotId);
    case "file": {
      const file = service.readFile(who, body.reviewId, body.fileId);
      const offset = body.offset ?? 0,
        limit = body.limit ?? 500;
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new ReviewError("invalid_input", "Invalid line offset.");
      pageSize(limit, 1000);
      const path = file.new_path || file.old_path || "";
      const old = highlightSource(path, file.oldText ?? ""),
        next = highlightSource(path, file.newText ?? "");
      const diff =
        file.change_kind === "source"
          ? null
          : compareSource(file.oldText, file.newText);
      const page = diff?.slice(offset, offset + limit);
      const oldNumbers = new Set(page?.map((row) => row.oldLine)),
        newNumbers = new Set(page?.map((row) => row.newLine));
      return {
        ...file,
        oldText: undefined,
        newText: undefined,
        old: {
          ...old,
          lines: page
            ? old.lines.filter((line) => oldNumbers.has(line.number))
            : old.lines.slice(offset, offset + limit),
          total: old.lines.length,
        },
        new: {
          ...next,
          lines: page
            ? next.lines.filter((line) => newNumbers.has(line.number))
            : next.lines.slice(offset, offset + limit),
          total: next.lines.length,
        },
        diff: page ?? null,
        diffTotal: diff?.length ?? 0,
        offset,
        limit,
      };
    }
    case "history":
      operator(who);
      return reader().history(body.path, body.limit, body.skip);
    case "threads":
      return service.listThreads(who, body.reviewId, body);
    case "thread": {
      // All asynchronous host checks precede the discussion read. No stale
      // discussion row can survive a same-thread mutation during those checks.
      await recheck();
      const result = service.getThread(
        who,
        body.threadId,
        body.after === undefined ? 0 : Number(body.after),
        body.limit,
      );
      const sourcePath = result.anchor.side === "old"
        ? result.source.oldPath
        : result.source.newPath ?? result.source.oldPath;
      const currentSource = ctx.kind === "agent" && sourcePath
        ? reader().currentStatus(
            sourcePath,
            result.source.blobSha256,
            result.anchor.side === "old" ? null : result.source.fileIdentity,
          )
        : undefined;
      // Source inspection is observational, never a refresh/re-anchor or permission grant.
      return {
        ...result,
        currentSource,
        messages: result.messages.map((message) => ({
          ...message,
          html: message.body === null ? null : renderComment(message.body),
        })),
      };
    }
    case "projection":
      return service.project(who, body.threadId, body.fileId);
    case "reanchor":
      if (body.confirm !== true)
        throw new ReviewError(
          "confirmation_required",
          "Confirm re-anchoring this concern.",
        );
      return service.reanchor(
        who,
        body.threadId,
        {
          fileId: body.fileId,
          side: body.side,
          range: body.range,
          reopen: body.reopen === true,
        },
        mutation(body),
      );
    case "comment":
      return service.createThread(
        who,
        body.reviewId,
        {
          fileId: body.fileId,
          side: body.side,
          range: body.range,
          body: body.body,
        },
        mutation(body),
      );
    case "reply":
      return service.reply(
        who,
        body.threadId,
        body.body,
        mutation(body),
        body.assignmentEpoch,
        body.reopen === true,
      );
    case "edit":
      return service.editMessage(
        who,
        body.messageId,
        body.body,
        mutation(body),
        body.assignmentEpoch,
      );
    case "deleteMessage":
      if (body.confirm !== true)
        throw new ReviewError(
          "confirmation_required",
          "Confirm deleting this message.",
        );
      return service.editMessage(
        who,
        body.messageId,
        null,
        mutation(body),
        body.assignmentEpoch,
      );
    case "deleteThread":
      if (body.confirm !== true)
        throw new ReviewError(
          "confirmation_required",
          "Confirm deleting this discussion.",
        );
      return service.deleteThread(who, body.threadId, mutation(body));
    case "resolve":
      return service.resolveThread(
        who,
        body.threadId,
        {
          explanation: body.explanation,
          evidence: body.evidence,
          fileId: body.fileId,
          assignmentEpoch: body.assignmentEpoch,
        },
        mutation(body),
      );
    case "reopen":
      return service.reopen(who, body.threadId, mutation(body));
    case "reassign": {
      const selected = await resolveHostTarget(ctx, body.target ?? {});
      return service.reassign(who, body.threadId, selected, mutation(body));
    }
    case "drafts":
      return service.listDrafts(who, body.reviewId);
    case "deleteDraft":
      return service.deleteDraft(
        who,
        body.reviewId,
        body.draftId,
        mutation(body),
      );
    case "anchor":
      return service.makeAnchor(
        who,
        body.reviewId,
        body.fileId,
        body.side,
        body.range,
      );
    case "draft":
      return service.saveDraft(
        who,
        body.reviewId,
        {
          id: body.draftId,
          threadId: body.threadId,
          anchor: body.fileId
            ? service.makeAnchor(
                who,
                body.reviewId,
                body.fileId,
                body.side,
                body.range,
              )
            : body.anchor,
          body: body.body,
        },
        mutation(body),
      );
    case "preview": {
      operator(who);
      const selected = await resolveHostTarget(ctx, body.target ?? {});
      return service.preview(who, body.reviewId, {
        target: selected,
        items: body.items,
        summary: body.summary,
      });
    }
    case "send": {
      operator(who);
      const selected = await resolveHostTarget(ctx, body.target ?? {});
      const input: DispatchInput = {
        target: selected,
        items: body.items,
        summary: body.summary,
      };
      const receipt = service.submit(who, body.reviewId, input, mutation(body));
      return service.deliver(who, receipt.dispatchId, {
        enqueue: (request) =>
          ctx.enqueue({
            target: {
              chatJid: request.target.chatId,
              incarnation: request.target.incarnation,
            },
            content: request.content,
            mode: "queue",
          }),
      });
    }
    case "replySend": {
      operator(who);
      const selected = await resolveHostTarget(ctx, body.target ?? {});
      const receipt = service.replyAndSubmit(
        who,
        body.threadId,
        body.body,
        selected,
        mutation(body),
        body.reopen === true,
      );
      return service.deliver(who, receipt.dispatchId, {
        enqueue: (request) =>
          ctx.enqueue({
            target: {
              chatJid: request.target.chatId,
              incarnation: request.target.incarnation,
            },
            content: request.content,
            mode: "queue",
          }),
      });
    }
    case "dispatches":
      return service.listDispatches(who, body.reviewId, body.after, body.limit);
    case "dispatch":
      return service.inspectDispatch(who, body.dispatchId);
    case "work":
      return service.updateWork(
        who,
        body.dispatchId,
        body.threadId,
        {
          state: body.state,
          itemVersion: body.itemVersion,
          threadVersion: body.threadVersion,
          assignmentEpoch: body.assignmentEpoch,
        },
        mutation(body),
      );
    case "retry": {
      operator(who);
      const current = service.inspectDispatch(who, body.dispatchId);
      await resolveHostTarget(ctx, current.target);
      service.retry(who, body.dispatchId, mutation(body));
      return service.deliver(who, body.dispatchId, {
        enqueue: (request) =>
          ctx.enqueue({
            target: {
              chatJid: request.target.chatId,
              incarnation: request.target.incarnation,
            },
            content: request.content,
            mode: "queue",
          }),
      });
    }
    case "reconcile":
      if (body.confirm !== true)
        throw new ReviewError(
          "confirmation_required",
          "Confirm evidence-based reconciliation.",
        );
      return service.reconcile(
        who,
        body.dispatchId,
        {
          decision: body.decision,
          evidence: body.evidence,
          attemptId: body.attemptId,
          hostRowId: body.hostRowId,
        },
        mutation(body),
      );
    case "events":
      return service.events(who, body.reviewId, body.after, body.limit);
    default:
      throw new ReviewError("unknown_action", "Unknown Code Review action.");
  }
}
export async function handleReviewRequest(
  payload: unknown,
  req: Request,
  context?: LocalContext | null,
) {
  try {
    const ctx = requireContext(
      context ?? getRuntime()?.localContext?.getRequestContext(req),
    );
    const body = record(payload);
    return {
      ok: true,
      result: await reviewAction(ctx, String(body.action || ""), body),
    };
  } catch (error) {
    const e = error as ReviewError;
    return {
      ok: false,
      error: {
        code: e.code || "operation_failed",
        message:
          e instanceof ReviewError ? e.message : "Review operation failed.",
        status: e.status || 500,
      },
    };
  }
}
const register = (globalThis as Record<string, any>)
  .__piclaw_registerAddonConfigApi;
if (typeof register === "function")
  register(
    "code-review",
    "action",
    { set: handleReviewRequest },
    import.meta.dir,
  );
