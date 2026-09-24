import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

const SAVED = "export const retained = 'snapshot';\n";

test("CR-182 copied store preserves records but denies a different host workspace identity", async () => {
  const original = mkdtempSync(join(tmpdir(), "review-restore-source-"));
  const restored = mkdtempSync(join(tmpdir(), "review-restore-target-"));
  const originalPath = join(original, "source.ts");
  const restorePath = join(restored, "source.ts");
  writeFileSync(originalPath, SAVED);
  writeFileSync(restorePath, SAVED);
  const originalDb = join(original, "reviews.db");
  const restoredDb = join(restored, "reviews.db");
  const initial = new ReviewService(originalDb);
  let copy: ReviewService | undefined;
  const target = { chatJid: "web:worker", incarnation: "branch-1", agentName: "worker", label: "Worker", active: false };
  const ctx = (root: string, workspaceId: string, incarnation = target.incarnation, kind: "operator" | "agent" = "operator"): LocalContext => ({
    version: 1, accessMode: "single-user", ownerId: "owner", actorId: kind === "agent" ? incarnation : "human", kind,
    workspaceRoot: root, workspaceId, ...(kind === "agent" ? { chatJid: target.chatJid, chatIncarnation: incarnation } : {}),
    async listTargets() { return [target]; },
    async resolveTarget(input) { return input.incarnation && input.incarnation !== target.incarnation ? null : target; },
    async enqueue() { throw Error("Restored unknown work must never enqueue automatically."); },
  });
  try {
    const trusted = ctx(original, "workspace-one");
    const created: any = await reviewAction(trusted, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "create" }, initial);
    const thread: any = await reviewAction(trusted, "comment", {
      reviewId: created.reviewId, fileId: created.files[0], side: "source", body: "Retained discussion", requestId: "thread",
    }, initial);
    const draft: any = await reviewAction(trusted, "draft", { reviewId: created.reviewId, threadId: thread.threadId, body: "Private retained draft", requestId: "draft" }, initial);
    const dispatched = initial.submit({ ownerId: trusted.ownerId, actorId: trusted.actorId, kind: "operator", workspaceId: trusted.workspaceId },
      created.reviewId, { target: { chatId: target.chatJid, incarnation: target.incarnation, label: target.label }, items: [{ threadId: thread.threadId, version: 1 }] }, { requestId: "send" });
    await initial.deliver({ ownerId: trusted.ownerId, actorId: trusted.actorId, kind: "operator", workspaceId: trusted.workspaceId }, dispatched.dispatchId,
      { async enqueue() { throw Error("ack lost after acceptance"); } });
    initial.close();
    copyFileSync(originalDb, restoredDb);
    copy = new ReviewService(restoredDb);
    expect(copy.recoverInterrupted()).toBe(0);
    // A real host derives workspaceId from its canonical root. Matching paths
    // in a new root must not grant access to the retained review.
    const newHost = ctx(restored, "workspace-two");
    await expect(reviewAction(newHost, "review", { reviewId: created.reviewId }, copy)).rejects.toThrow("unavailable");
    await expect(reviewAction(newHost, "file", { reviewId: created.reviewId, fileId: created.files[0] }, copy)).rejects.toThrow("unavailable");
    await expect(reviewAction(newHost, "thread", { threadId: thread.threadId }, copy)).rejects.toThrow("unavailable");
    const sameWorkspace = ctx(restored, trusted.workspaceId);
    const saved: any = await reviewAction(sameWorkspace, "file", { reviewId: created.reviewId, fileId: created.files[0] }, copy);
    expect(saved.new.lines[0].text).toBe(SAVED.trim());
    expect(saved.currentSource.status).toBe("replaced");
    expect(saved.currentSource).not.toHaveProperty("savedHash");
    expect((await reviewAction(sameWorkspace, "drafts", { reviewId: created.reviewId }, copy) as any[]).map((row) => row.id)).toEqual([draft.draftId]);
    const assigned = ctx(restored, trusted.workspaceId, target.incarnation, "agent");
    const agentThread: any = await reviewAction(assigned, "thread", { threadId: thread.threadId }, copy);
    expect(agentThread.currentSource.status).toBe("replaced");
    expect(agentThread.messages.map((m: any) => m.body)).toEqual(["Retained discussion"]);
    expect(JSON.stringify(agentThread)).not.toContain("Private retained draft");
    const receipt: any = await reviewAction(sameWorkspace, "dispatch", { dispatchId: dispatched.dispatchId }, copy);
    expect(receipt.attempts[0].state).toBe("unknown");
    expect(receipt.items).toHaveLength(1);
    let reenqueue = 0;
    await copy.deliver({ ownerId: sameWorkspace.ownerId, actorId: sameWorkspace.actorId, kind: "operator", workspaceId: sameWorkspace.workspaceId }, dispatched.dispatchId,
      { async enqueue() { reenqueue++; return { status: "accepted", rowId: 2 }; } });
    expect(reenqueue).toBe(0);
    expect((await reviewAction(sameWorkspace, "dispatch", { dispatchId: dispatched.dispatchId }, copy) as any).attempts[0].state).toBe("unknown");
    await expect(reviewAction(ctx(restored, "workspace-other"), "thread", { threadId: thread.threadId }, copy)).rejects.toThrow("unavailable");
    await expect(reviewAction(ctx(restored, trusted.workspaceId, "branch-reused", "agent"), "thread", { threadId: thread.threadId }, copy)).rejects.toThrow("Agent chat no longer exists");
    expect(await Bun.file(restorePath).text()).toBe(SAVED);
  } finally {
    copy?.close();
    try { initial.close(); } catch {}
    rmSync(original, { recursive: true, force: true });
    rmSync(restored, { recursive: true, force: true });
  }
}, 45_000);
