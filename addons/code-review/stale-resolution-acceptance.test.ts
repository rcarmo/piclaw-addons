import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

test("CR-042 agent cannot resolve an old guidance version after the operator edits instructions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-stale-resolution-"));
  writeFileSync(join(dir, "source.ts"), "export const value = 1;\n");
  const store = new ReviewService(join(dir, "review.db"));
  const target = { chatJid: "web:worker", incarnation: "branch-1", agentName: "worker", label: "Worker", active: false };
  const operator: LocalContext = {
    version: 1, accessMode: "single-user", ownerId: "owner", actorId: "human", kind: "operator", workspaceRoot: dir, workspaceId: "workspace",
    async listTargets() { return [target]; }, async resolveTarget() { return target; },
    async enqueue() { return { status: "accepted", rowId: 1 }; },
  };
  const agentBase: LocalContext = { ...operator, kind: "agent", actorId: "branch-1", chatJid: target.chatJid, chatIncarnation: target.incarnation };
  try {
    const review: any = await reviewAction(operator, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "create" }, store);
    const created: any = await reviewAction(operator, "comment", { reviewId: review.reviewId, fileId: review.files[0], side: "source", range: { startLine: 1, endLine: 1 }, body: "Check behavior", requestId: "root" }, store);
    const dispatched: any = await reviewAction(operator, "send", { reviewId: review.reviewId, target: { chatId: target.chatJid, incarnation: target.incarnation }, items: [{ threadId: created.threadId, version: 1 }], requestId: "send" }, store);
    const agent = { ...agentBase, reference: { addonId: "code-review", intentId: dispatched.id } } satisfies LocalContext;
    expect(dispatched.attempts[0].state).toBe("accepted");
    const first: any = await reviewAction(agent, "thread", { threadId: created.threadId }, store);
    expect(first.version).toBe(1);
    const edited: any = await reviewAction(operator, "edit", { messageId: created.messageId, body: "Check behavior and keep API stable", expectedVersion: 1, requestId: "edit" }, store);
    expect(edited.threadVersion).toBe(2);
    await expect(reviewAction(agent, "resolve", { threadId: created.threadId, fileId: review.files[0], explanation: "I addressed version 1", evidence: ["source.ts#L1"], assignmentEpoch: 1, expectedVersion: first.version, requestId: "stale-resolve" }, store)).rejects.toThrow("record changed");
    expect(store.getThread(operator, created.threadId).state).toBe("open");
    expect((store.events(operator, review.reviewId) as any[]).filter((event) => event.kind === "thread.resolved")).toHaveLength(0);
    const current: any = await reviewAction(agent, "thread", { threadId: created.threadId }, store);
    expect(current.version).toBe(2);
    expect(current.messages[0].body).toBe("Check behavior and keep API stable");
    expect(current.source.fileId).toBe(review.files[0]);
    const resolved: any = await reviewAction(agent, "resolve", { threadId: created.threadId, fileId: review.files[0], explanation: "Verified updated guidance", evidence: ["source.ts#L1"], assignmentEpoch: 1, expectedVersion: current.version, requestId: "fresh-resolve" }, store);
    expect(resolved.version).toBe(3);
    const final = store.getThread(operator, created.threadId);
    expect(final.state).toBe("resolved");
    expect(final.messages.map((message) => message.body)).toEqual(["Check behavior and keep API stable", "Verified updated guidance"]);
    const events = (store.events(operator, review.reviewId) as any[]).filter((event) => event.kind === "thread.resolved");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].data_json)).toMatchObject({ addressedVersion: 2, fileId: review.files[0], evidence: ["source.ts#L1"] });
    expect(store.database.all("PRAGMA foreign_key_check")).toEqual([]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
