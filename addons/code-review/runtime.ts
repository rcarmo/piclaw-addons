import { join } from "node:path";
import {
  ReviewService,
  type AgentDispatchScope,
  type DispatchInput,
} from "./dispatch.js";
import { SourceReader, type CaptureRequest } from "./source.js";
import { compareSource, highlightSourcePage, type DiffRow } from "./render-source.js";
import { renderComment } from "./markdown.js";
import {
  getRuntime,
  requireContext,
  resolveHostTarget,
  storeIdentity,
  type LocalContext,
} from "./host.js";
import { LIMITS, REVIEW_DISPATCH_ADDON_ID, ReviewError, type Mutation, type ReviewIdentity } from "./contracts.js";
import { operator, pageSize } from "./validation.js";
interface ServiceState {
  service: ReviewService;
  close: () => void;
  workspaceId: string | null;
}
const states = new Map<string, ServiceState>();
// Cache only small immutable diff rows; the large permitted files still use
// the computation budget on each request rather than holding many expanded rows.
// Scope by service (owned SQLite store), review and snapshot file.
const diffPages = new WeakMap<ReviewService, Map<string, DiffRow[]>>();
const DIFF_CACHE_BYTES = 256 * 1024;
const DIFF_CACHE_ROWS = 10_000;
const DIFF_CACHE_ROW_BYTES = 512 * 1024;
interface ActiveAgentScope extends Omit<AgentDispatchScope, "threadIds" | "fileIds"> {
  threadIds: ReadonlySet<string>;
  fileIds: ReadonlySet<string>;
}
function diffForFile(service: ReviewService, reviewId: string, file: {
  id: string; oldText: string | null; newText: string | null;
}): DiffRow[] {
  const key = `${reviewId}:${file.id}`;
  let cache = diffPages.get(service);
  const hit = cache?.get(key);
  if (hit) {
    cache!.delete(key);
    cache!.set(key, hit);
    return hit;
  }
  const rows = compareSource(file.oldText, file.newText);
  const inputBytes = Buffer.byteLength(file.oldText ?? "") + Buffer.byteLength(file.newText ?? "");
  if (inputBytes <= DIFF_CACHE_BYTES && rows.length <= DIFF_CACHE_ROWS) {
    let rowBytes = 0;
    for (const row of rows) {
      rowBytes += Buffer.byteLength(row.text);
      if (rowBytes > DIFF_CACHE_ROW_BYTES) break;
    }
    if (rowBytes <= DIFF_CACHE_ROW_BYTES) {
      cache ??= new Map();
      if (cache.size >= 2) cache.delete(cache.keys().next().value!);
      cache.set(key, rows);
      diffPages.set(service, cache);
    }
  }
  return rows;
}
function openThreadCountsForReview(service: ReviewService, reviewId: string) {
  const rows = service.database.all<{
    file_path: string | null;
    open_threads: number;
  }>(
    `SELECT CASE json_extract(t.anchor_json,'$.side')
        WHEN 'old' THEN sf.old_path
        ELSE COALESCE(sf.new_path,sf.old_path)
      END AS file_path,
      COUNT(*) AS open_threads
     FROM threads t
     JOIN snapshot_files sf
       ON sf.review_id=t.review_id
      AND sf.id=json_extract(t.anchor_json,'$.snapshotFileId')
     WHERE t.review_id=? AND t.state='open'
     GROUP BY file_path`,
    reviewId,
  );
  return new Map(
    rows
      .filter((row) => row.file_path !== null)
      .map((row) => [row.file_path!, row.open_threads]),
  );
}
function fileStatsForRow(
  service: ReviewService,
  who: ReviewIdentity,
  reviewId: string,
  file: {
    id: string;
    old_path: string | null;
    new_path: string | null;
    change_kind: string;
  },
  openThreadsByPath: Map<string, number>,
) {
  const openThreads = [...new Set([file.old_path, file.new_path].filter((path): path is string => path !== null))]
    .reduce((sum, path) => sum + (openThreadsByPath.get(path) ?? 0), 0);
  if (["source", "unchanged"].includes(file.change_kind))
    return { added: 0, deleted: 0, openThreads };
  try {
    const full = service.readFile(who, reviewId, file.id);
    const diff = diffForFile(service, reviewId, full);
    return {
      added: diff.filter((row) => row.kind === "added").length,
      deleted: diff.filter((row) => row.kind === "deleted").length,
      openThreads,
    };
  } catch (error) {
    if (error instanceof ReviewError && error.code === "limit")
      return { added: null, deleted: null, openThreads };
    throw error;
  }
}
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
  const cleanup = () => {
    try { const workspaceId = states.get(dir)?.workspaceId; if (workspaceId) service.cleanupConfiguredReviews(workspaceId); }
    catch (error) { console.warn('[code-review] Retention cleanup failed', error instanceof Error ? error.name : 'Error'); }
  };
  const cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
  cleanupTimer.unref?.();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(cleanupTimer);
    service.close();
    states.delete(dir);
  };
  states.set(dir, { service, close, workspaceId: null });
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
}
function agentScopeUnavailable(): never {
  throw new ReviewError(
    "context_unavailable",
    "Verified review dispatch scope is unavailable.",
    403,
  );
}
function scopedNotFound(): never {
  throw new ReviewError(
    "not_found",
    "Review record is unavailable.",
    404,
  );
}
function scopeForAction(
  who: ReviewIdentity,
  service: ReviewService,
): ActiveAgentScope | null {
  if (who.kind !== "agent") return null;
  if (who.reference?.addonId !== REVIEW_DISPATCH_ADDON_ID || !who.reference.intentId)
    agentScopeUnavailable();
  const scope = service.agentDispatchScope(who, who.reference.intentId);
  return {
    ...scope,
    threadIds: new Set(scope.threadIds),
    fileIds: new Set(scope.fileIds),
  };
}
function assertScopedReview(scope: ActiveAgentScope | null, reviewId: unknown): void {
  if (!scope || reviewId === undefined) return;
  if (typeof reviewId !== "string" || reviewId !== scope.reviewId) scopedNotFound();
}
function assertScopedDispatch(scope: ActiveAgentScope | null, dispatchId: unknown): void {
  if (!scope || dispatchId === undefined) return;
  if (typeof dispatchId !== "string" || dispatchId !== scope.dispatchId) scopedNotFound();
}
function assertScopedThread(scope: ActiveAgentScope | null, threadId: unknown): void {
  if (!scope || threadId === undefined) return;
  if (typeof threadId !== "string" || !scope.threadIds.has(threadId)) scopedNotFound();
}
function assertScopedFile(scope: ActiveAgentScope | null, fileId: unknown): void {
  if (!scope || fileId === undefined) return;
  if (typeof fileId !== "string" || !scope.fileIds.has(fileId)) scopedNotFound();
}
function assertScopedMessage(
  scope: ActiveAgentScope | null,
  service: ReviewService,
  messageId: unknown,
): void {
  if (!scope || messageId === undefined) return;
  if (typeof messageId !== "string") scopedNotFound();
  const threadId = service.messageThreadId(messageId);
  if (!threadId || !scope.threadIds.has(threadId)) scopedNotFound();
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
  // Operator-only receipt lookup must not probe an agent-bound thread first.
  if (action === "replyReceipt") operator(who);
  // Flat fields are informational; the method revalidates the host-owned active scope on every action.
  await ctx.listTargets();
  const service = providedService ?? reviewService();
  for (const state of states.values()) if (state.service === service) state.workspaceId = ctx.workspaceId;
  await verifyAgentBinding(ctx);
  const agentScope = scopeForAction(who, service);
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
    case "review": {
      const review = service.getReview(who, body.reviewId);
      return { ...review, gitAvailable: reader().hasGit(review.focus_path) };
    }
    case "getSettings":
      operator(who);
      return service.getSettings(who);
    case "saveSettings":
      operator(who);
      if (body.retentionDays !== null && body.confirm !== true) throw new ReviewError('confirmation_required','Confirm automatic deletion.');
      return service.saveSettings(who,body.retentionDays);
    case "cleanup":
      operator(who);
      return service.cleanupOldReviews(who);
    case "deleteReview":
      if (body.confirm !== true) throw new ReviewError('confirmation_required','Confirm review deletion.');
      return service.deleteReview(who, {
        reviewId: body.reviewId,
        expectedVersion: body.expectedVersion,
        requestId: body.requestId,
      });
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
    case "files": {
      const files = service.snapshotFiles(who, body.reviewId, body.snapshotId);
      const openThreadsByPath = openThreadCountsForReview(service, body.reviewId);
      const deadline = Date.now() + 1000;
      return files.map((file) => ({
        ...file,
        stats: Date.now() < deadline
          ? fileStatsForRow(service, who, body.reviewId, file, openThreadsByPath)
          : { added: null, deleted: null, openThreads: [...new Set([file.old_path, file.new_path])]
              .reduce((sum, path) => sum + (path ? openThreadsByPath.get(path) ?? 0 : 0), 0) },
      }));
    }
    case "file": {
      const file = service.readFile(who, body.reviewId, body.fileId);
      const offset = body.offset ?? 0,
        limit = body.limit ?? 500;
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new ReviewError("invalid_input", "Invalid line offset.");
      pageSize(limit, 1000);
      const diff = file.change_kind === "source"
        ? null : diffForFile(service, body.reviewId, file);
      const page = diff?.slice(offset, offset + limit).map((row) => ({ ...row }));
      const oldNumbers = page ? new Set(page.map((row) => row.oldLine)) : undefined;
      const newNumbers = page ? new Set(page.map((row) => row.newLine)) : undefined;
      const old = highlightSourcePage(file.old_path ?? "", file.oldText ?? "", offset, limit, oldNumbers),
        next = highlightSourcePage(file.new_path ?? "", file.newText ?? "", offset, limit, newNumbers);
      return {
        ...file,
        oldText: undefined,
        newText: undefined,
        currentSource: file.change_kind === "source" && file.new_path
          ? reader().currentStatus(file.new_path, file.new_hash, file.file_identity)
          : null,
        old,
        new: next,
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
      assertScopedReview(agentScope, body.reviewId);
      return agentScope
        ? service.listScopedThreads(who, agentScope.dispatchId, body)
        : service.listThreads(who, body.reviewId, body);
    case "thread": {
      assertScopedThread(agentScope, body.threadId);
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
    case "replyReceipt":
      operator(who);
      return service.replyReceipt(who, body.reviewId, body.requestId, body.threadId);
    case "projection":
      assertScopedThread(agentScope, body.threadId);
      assertScopedFile(agentScope, body.fileId);
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
      assertScopedThread(agentScope, body.threadId);
      return service.reply(
        who,
        body.threadId,
        body.body,
        mutation(body),
        body.assignmentEpoch,
        body.reopen === true,
      );
    case "edit":
      assertScopedMessage(agentScope, service, body.messageId);
      return service.editMessage(
        who,
        body.messageId,
        body.body,
        mutation(body),
        body.assignmentEpoch,
      );
    case "deleteMessage":
      assertScopedMessage(agentScope, service, body.messageId);
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
      assertScopedThread(agentScope, body.threadId);
      assertScopedFile(agentScope, body.fileId);
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
            reference: request.reference,
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
            reference: request.reference,
          }),
      });
    }
    case "dispatches":
      assertScopedReview(agentScope, body.reviewId);
      if (!agentScope) return service.listDispatches(who, body.reviewId, body.after, body.limit);
      pageSize(body.limit, LIMITS.threadPage);
      if ((body.after ?? "") >= agentScope.dispatchId) return [];
      return [service.directoryDispatch(who, agentScope.dispatchId)];
    case "dispatch":
      assertScopedDispatch(agentScope, body.dispatchId);
      return service.inspectDispatch(who, body.dispatchId);
    case "work":
      assertScopedDispatch(agentScope, body.dispatchId);
      assertScopedThread(agentScope, body.threadId);
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
            reference: request.reference,
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
