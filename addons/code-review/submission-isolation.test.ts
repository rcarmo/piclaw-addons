import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

test("RC-4 each verified submission sees only its selected concerns, including within one review/chat", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-submission-"));
  writeFileSync(join(root, "source.ts"), "const value = 1;\n");
  let store = new ReviewService(join(root, "review.db"));
  const target = { chatJid: "web:worker", incarnation: "life-1", label: "Worker", agentName: "worker", active: false };
  const queued: any[] = [];
  const operator: LocalContext = { version: 1, accessMode: "single-user", ownerId: "owner", actorId: "human", kind: "operator", workspaceId: "workspace", workspaceRoot: root,
    async listTargets() { return [target]; }, async resolveTarget() { return target; },
    async enqueue(input) { queued.push(input); return { status: "accepted", rowId: queued.length }; } };
  const call = (ctx: LocalContext, action: string, input: any) => reviewAction(ctx, action, input, store) as Promise<any>;
  const agent = (intentId?: string): LocalContext => ({ ...operator, kind: "agent", actorId: "worker", chatJid: target.chatJid, chatIncarnation: target.incarnation,
    ...(intentId ? { reference: { addonId: "code-review", intentId } } : {}) });
  try {
    const review = await call(operator, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "review" });
    const threads = [];
    for (const n of [1, 2, 3]) threads.push(await call(operator, "comment", { reviewId: review.reviewId, fileId: review.files[0], side: "source", body: `Concern ${n}`, requestId: `thread-${n}` }));
    const send = (r: string, thread: any, key: string) => call(operator, "send", { reviewId: r, target: { agentName: "worker" }, items: [{ threadId: thread.threadId, version: thread.version }], requestId: key });
    const a = await send(review.reviewId, threads[0], "send-a");
    const b = await send(review.reviewId, threads[1], "send-b");
    const other = await call(operator, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "other" });
    const otherThread = await call(operator, "comment", { reviewId: other.reviewId, fileId: other.files[0], side: "source", body: "Other review", requestId: "other-thread" });
    const c = await send(other.reviewId, otherThread, "send-c");
    expect(queued.map((q) => q.reference)).toEqual([a,b,c].map((d) => ({ addonId: "code-review", intentId: d.id })));
    expect(queued.every((q) => q.mode === "queue")).toBe(true);
    const who = agent(a.id);
    for (const context of [agent(), { ...who, reference: { addonId: "wrong-addon", intentId: a.id } }])
      await expect(call(context, "thread", { threadId: threads[0].threadId, reference: who.reference })).rejects.toThrow("scope is unavailable");
    expect((await call(who, "dispatches", {})).map((d: any) => d.id)).toEqual([a.id]);
    expect((await call(who, "threads", { reviewId: review.reviewId })).map((t: any) => t.id)).toEqual([threads[0].threadId]);
    expect((await call(who, "thread", { threadId: threads[0].threadId })).messages[0].body).toBe("Concern 1");
    for (const thread of [threads[1], threads[2], otherThread]) {
      for (const [action, body] of [
        ["thread", {}], ["reply", { body: "forged", expectedVersion: 1, assignmentEpoch: 1, requestId: "forged-reply" }],
        ["resolve", { fileId: review.files[0], explanation: "forged", expectedVersion: 1, assignmentEpoch: 1, requestId: "forged-resolve" }],
        ["projection", { fileId: review.files[0] }],
      ] as const) await expect(call(who, action, { threadId: thread.threadId, ...body })).rejects.toThrow("unavailable");
    }
    for (const dispatchId of [b.id,c.id]) await expect(call(who, "dispatch", { dispatchId })).rejects.toThrow("unavailable");
    await expect(call(who, "work", { dispatchId: b.id, threadId: threads[1].threadId, state: "completed", itemVersion: 1, threadVersion: 1, assignmentEpoch: 1, requestId: "forged-work" })).rejects.toThrow("unavailable");
    await expect(call(who, "threads", { reviewId: other.reviewId })).rejects.toThrow("unavailable");
    await expect(call(who, "resolve", { threadId: threads[0].threadId, fileId: other.files[0], explanation: "wrong source", expectedVersion: 1, assignmentEpoch: 1, requestId: "wrong-file" })).rejects.toThrow("unavailable");
    expect((await call(agent(b.id), "thread", { threadId: threads[1].threadId })).messages[0].body).toBe("Concern 2");
    const reply = await call(who, "reply", { threadId: threads[0].threadId, body: "Correct submission", expectedVersion: 1, assignmentEpoch: 1, requestId: "reply-a" });
    await expect(call(agent(b.id), "edit", { messageId: reply.messageId, body: "Wrong submission", expectedVersion: 1, assignmentEpoch: 1, requestId: "edit-b" })).rejects.toThrow("unavailable");
    store.close(); store = new ReviewService(join(root, "review.db"));
    expect((await call(who, "thread", { threadId: threads[0].threadId })).messages.at(-1).body).toBe("Correct submission");
    await call(operator, "reassign", { threadId: threads[0].threadId, target: { agentName: "worker" }, expectedVersion: 2, requestId: "reassign-a" });
    await expect(call(who, "thread", { threadId: threads[0].threadId })).rejects.toThrow("unavailable");
    expect(queued).toHaveLength(3);

    // A single Send can include all concerns across multiple files.
    writeFileSync(join(root, "other.ts"), "const other = 2;\n");
    const batchReview = await call(operator, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "batch-review" });
    const expanded = await call(operator, "addFile", { reviewId: batchReview.reviewId, snapshotId: batchReview.snapshotId, path: "other.ts", requestId: "batch-add-file" });
    const files = await call(operator, "files", { reviewId: batchReview.reviewId, snapshotId: expanded.snapshotId });
    expect(files).toHaveLength(2);
    const batchThreads = [];
    for (const file of files) batchThreads.push(await call(operator, "comment", { reviewId: batchReview.reviewId, fileId: file.id, side: "source", body: `Review ${file.new_path}`, requestId: `batch-${file.id}` }));
    const batch = await call(operator, "send", { reviewId: batchReview.reviewId, target: { agentName: "worker" }, items: batchThreads.map((t) => ({ threadId: t.threadId, version: t.version })), requestId: "send-all" });
    expect(queued).toHaveLength(4);
    const batchAgent = agent(batch.id);
    expect((await call(batchAgent, "threads", { reviewId: batchReview.reviewId })).map((t: any) => t.id).sort()).toEqual(batchThreads.map((t) => t.threadId).sort());
    for (const t of batchThreads) {
      const read = await call(batchAgent, "thread", { threadId: t.threadId });
      const reply = await call(batchAgent, "reply", { threadId: t.threadId, body: "Checked in the shared submission", expectedVersion: read.version, assignmentEpoch: read.assignment_epoch, requestId: `batch-reply-${t.threadId}` });
      await call(batchAgent, "resolve", { threadId: t.threadId, fileId: read.source.fileId, explanation: "Verified", expectedVersion: reply.version, assignmentEpoch: read.assignment_epoch, requestId: `batch-resolve-${t.threadId}` });
      expect((await call(operator, "thread", { threadId: t.threadId })).state).toBe("resolved");
    }
    await expect(call(batchAgent, "thread", { threadId: threads[1].threadId })).rejects.toThrow("unavailable");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
