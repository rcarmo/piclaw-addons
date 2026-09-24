import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

test("CR-043/044 explicit reassignment retains history, rejects old lifetime, and leaves prior delivery accepted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-reassignment-"));
  writeFileSync(join(dir, "source.ts"), "export const value = 1;\n");
  const store = new ReviewService(join(dir, "review.db"));
  const oldTarget = { chatJid: "web:worker", incarnation: "branch-old", agentName: "worker", label: "Worker", active: false };
  const nextTarget = { chatJid: "web:reviewer", incarnation: "branch-next", agentName: "reviewer", label: "Reviewer", active: false };
  let queued = 0;
  const ctx: LocalContext = { version: 1, accessMode: "single-user", ownerId: "owner", actorId: "human", kind: "operator", workspaceRoot: dir, workspaceId: "workspace",
    async listTargets() { return [oldTarget, nextTarget]; },
    async resolveTarget(input) { return [oldTarget, nextTarget].find((t) => (!input.chatJid || t.chatJid === input.chatJid) && (!input.agentName || t.agentName === input.agentName) && (!input.incarnation || t.incarnation === input.incarnation)) ?? null; },
    async enqueue() { return { status: "accepted", rowId: ++queued }; } };
  const agent = (target: typeof oldTarget, intentId?: string): LocalContext => ({ ...ctx, kind: "agent", actorId: target.incarnation, chatJid: target.chatJid, chatIncarnation: target.incarnation, ...(intentId ? { reference: { addonId: "code-review", intentId } } : {}) });
  try {
    const review: any = await reviewAction(ctx, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "create" }, store);
    const thread: any = await reviewAction(ctx, "comment", { reviewId: review.reviewId, fileId: review.files[0], side: "source", body: "Keep this API stable", requestId: "root" }, store);
    const dispatch: any = await reviewAction(ctx, "send", { reviewId: review.reviewId, target: { chatId: oldTarget.chatJid, incarnation: oldTarget.incarnation }, items: [{ threadId: thread.threadId, version: 1 }], requestId: "send-old" }, store);
    const before = store.getThread(ctx, thread.threadId);
    expect(dispatch.attempts[0].state).toBe("accepted");
    const changed: any = await reviewAction(ctx, "reassign", { threadId: thread.threadId, target: { chatId: nextTarget.chatJid, incarnation: nextTarget.incarnation }, expectedVersion: 1, requestId: "reassign" }, store);
    const trusted = { ownerId: ctx.ownerId, actorId: ctx.actorId, kind: "operator" as const, workspaceId: ctx.workspaceId };
    const reassigned = store.submit(trusted, review.reviewId, { target: { chatId: nextTarget.chatJid, incarnation: nextTarget.incarnation, label: nextTarget.label }, items: [{ threadId: thread.threadId, version: 2 }] }, { requestId: "send-next" });
    await store.deliver(trusted, reassigned.dispatchId, { async enqueue() { return { status: "accepted" as const, rowId: 2 }; } });
    expect(changed).toMatchObject({ threadId: thread.threadId, version: 2, assignmentEpoch: 2 });
    const retained = store.getThread(ctx, thread.threadId);
    expect(retained.id).toBe(before.id);
    expect(retained.anchor).toEqual(before.anchor);
    expect(retained.messages.map((m) => m.body)).toEqual(["Keep this API stable"]);
    expect(retained.target).toMatchObject({ chatId: nextTarget.chatJid, incarnation: nextTarget.incarnation });
    const prior = store.inspectDispatch(ctx, dispatch.id);
    expect(prior.attempts[0]).toMatchObject({ state: "accepted", host_row_id: 1 });
    expect(prior.items[0]).toMatchObject({ thread_id: thread.threadId, work_state: "not_started" });
    expect(queued).toBe(1);
    await expect(reviewAction(agent(oldTarget, dispatch.id), "thread", { threadId: thread.threadId }, store)).rejects.toThrow("unavailable");
    await expect(reviewAction(agent(oldTarget, dispatch.id), "reply", { threadId: thread.threadId, body: "late", assignmentEpoch: 1, expectedVersion: 1, requestId: "late-old" }, store)).rejects.toThrow("unavailable");
    expect((await reviewAction(agent(oldTarget, dispatch.id), "dispatch", { dispatchId: dispatch.id }, store) as any).items[0]).toMatchObject({ unavailable: true, work_state: "superseded" });
    await expect(reviewAction(agent(nextTarget, reassigned.dispatchId), "reply", { threadId: thread.threadId, body: "stale epoch", assignmentEpoch: 1, expectedVersion: 2, requestId: "stale-epoch" }, store)).rejects.toThrow("assignment changed");
    const fresh: any = await reviewAction(agent(nextTarget, reassigned.dispatchId), "thread", { threadId: thread.threadId }, store);
    expect(fresh.assignment_epoch).toBe(2);
    expect(fresh.messages.map((m: any) => m.body)).toEqual(["Keep this API stable"]);
    const reply: any = await reviewAction(agent(nextTarget, reassigned.dispatchId), "reply", { threadId: thread.threadId, body: "I will keep it stable", assignmentEpoch: 2, expectedVersion: 2, requestId: "new-reply" }, store);
    expect(reply.version).toBe(3);
    expect(store.getThread(ctx, thread.threadId).messages.map((m) => m.body)).toEqual(["Keep this API stable", "I will keep it stable"]);
    expect(store.inspectDispatch(ctx, dispatch.id).attempts[0].state).toBe("accepted");
    expect(queued).toBe(1);
    expect(store.database.all("PRAGMA foreign_key_check")).toEqual([]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
