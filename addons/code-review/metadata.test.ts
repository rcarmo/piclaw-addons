import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";
import type { LocalTarget, ReviewIdentity, SourceCapture } from "./contracts.js";

const workspaceId = "workspace-1";
const worktreeId = "worktree-1";
const operator: ReviewIdentity = {
  ownerId: "owner:one",
  actorId: "human:one",
  kind: "operator",
  workspaceId,
};
const target: LocalTarget = {
  chatId: "web:worker",
  incarnation: "chat-1",
  label: "Worker",
};
const nextTarget: LocalTarget = {
  chatId: "web:reviewer",
  incarnation: "chat-2",
  label: "Reviewer",
};

let seq = 0;
const m = (expectedVersion?: number) => ({
  requestId: `metadata-${++seq}`,
  expectedVersion,
});

const agent = (selected: LocalTarget): ReviewIdentity => ({
  ownerId: operator.ownerId,
  actorId: `agent:${selected.incarnation}`,
  kind: "agent",
  workspaceId,
  chatId: selected.chatId,
  chatIncarnation: selected.incarnation,
});

function hostTarget(selected: LocalTarget, agentName: string) {
  return {
    chatJid: selected.chatId,
    incarnation: selected.incarnation,
    label: selected.label,
    agentName,
    active: false,
  };
}

function sourceCapture(text = "one\ntwo\nthree\n"): SourceCapture {
  return {
    workspaceId,
    worktreeId,
    mode: "source",
    base: null,
    head: null,
    capturedAt: new Date().toISOString(),
    files: [
      {
        oldPath: null,
        newPath: "src/main.ts",
        change: "source",
        oldText: null,
        newText: text,
        fileIdentity: "inode:main",
      },
    ],
  };
}

function metadataFixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-metadata-"));
  const service = new ReviewService(join(dir, "review.db"));
  const reviewId = service.createReview(
    operator,
    {
      workspaceId,
      worktreeId,
      title: "Metadata review",
      focusPath: "src/main.ts",
      target,
    },
    m(),
  ).reviewId;
  const captured = service.capture(operator, reviewId, sourceCapture(), m());
  const fileId = captured.files[0]!;
  const thread = service.createThread(
    operator,
    reviewId,
    {
      fileId,
      side: "source",
      range: { startLine: 2, endLine: 2 },
      body: "Keep validation",
    },
    m(),
  );
  const targets = [hostTarget(target, "worker"), hostTarget(nextTarget, "reviewer")];
  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: operator.ownerId,
    actorId: operator.actorId,
    kind: "operator",
    workspaceRoot: dir,
    workspaceId,
    async listTargets() {
      return targets;
    },
    async resolveTarget(input) {
      return (
        targets.find(
          (candidate) =>
            (!input.chatJid || candidate.chatJid === input.chatJid) &&
            (!input.incarnation || candidate.incarnation === input.incarnation) &&
            (!input.agentName || candidate.agentName === input.agentName),
        ) ?? null
      );
    },
    async enqueue() {
      return { status: "accepted" as const, rowId: 1 };
    },
  };
  return {
    dir,
    service,
    reviewId,
    fileId,
    snapshotId: captured.snapshotId,
    thread,
    ctx,
    cleanup() {
      service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("metadata summaries stay current, skip drafts, and enforce owner/workspace scope", () => {
  const f = metadataFixture();
  try {
    const edited = `Edited ${"x".repeat(300)}`;
    const reply = "Agent reply survives";
    f.service.reply(agent(target), f.thread.threadId, reply, m(1), 1);
    f.service.editMessage(operator, f.thread.messageId, edited, m(1));
    f.service.saveDraft(
      operator,
      f.reviewId,
      { threadId: f.thread.threadId, body: "PRIVATE DRAFT BODY" },
      m(),
    );

    const beforeDelete: any = f.service.listThreads(operator, f.reviewId)[0];
    expect(beforeDelete.summary).toEqual({
      body: Array.from(edited).slice(0, 240).join(""),
      authorKind: "operator",
      messageCount: 2,
      filePath: "src/main.ts",
      deliveryState: null,
      workState: null,
      hasUnsentGuidance: true,
    });
    expect(JSON.stringify(beforeDelete.summary)).not.toContain("PRIVATE DRAFT BODY");
    expect(() =>
      f.service.listThreads({ ...operator, workspaceId: "workspace-2" }, f.reviewId),
    ).toThrow("unavailable");
    expect(() =>
      f.service.listThreads(
        { ownerId: "owner:two", actorId: "human:two", kind: "operator", workspaceId },
        f.reviewId,
      ),
    ).toThrow("unavailable");

    f.service.editMessage(operator, f.thread.messageId, null, m(2));
    const afterDelete: any = f.service.listThreads(operator, f.reviewId)[0];
    expect(afterDelete.summary).toEqual({
      body: reply,
      authorKind: "agent",
      messageCount: 1,
      filePath: "src/main.ts",
      deliveryState: null,
      workState: null,
      hasUnsentGuidance: true,
    });
  } finally {
    f.cleanup();
  }
});

test("metadata delivery tracks the latest matching epoch and keeps delivery distinct from work", async () => {
  const f = metadataFixture();
  try {
    const accepted = f.service.submit(
      operator,
      f.reviewId,
      { target, items: [{ threadId: f.thread.threadId, version: 1 }] },
      m(),
    );
    await f.service.deliver(operator, accepted.dispatchId, {
      async enqueue() {
        return { status: "accepted", rowId: 11 };
      },
    });
    f.service.updateWork(
      agent(target),
      accepted.dispatchId,
      f.thread.threadId,
      {
        state: "in_progress",
        itemVersion: 1,
        threadVersion: 1,
        assignmentEpoch: 1,
      },
      m(),
    );
    expect((f.service.listThreads(operator, f.reviewId)[0] as any).summary).toMatchObject({
      deliveryState: "accepted",
      workState: "in_progress",
    });

    f.service.reassign(operator, f.thread.threadId, nextTarget, m(1));
    expect((f.service.listThreads(operator, f.reviewId)[0] as any).summary).toMatchObject({
      deliveryState: null,
      workState: null,
      hasUnsentGuidance: true,
    });

    const unknown = f.service.submit(
      operator,
      f.reviewId,
      { target: nextTarget, items: [{ threadId: f.thread.threadId, version: 2 }] },
      m(),
    );
    await f.service.deliver(operator, unknown.dispatchId, {
      async enqueue() {
        throw Error("receipt missing");
      },
    });
    expect((f.service.listThreads(operator, f.reviewId)[0] as any).summary).toMatchObject({
      deliveryState: "unknown",
      workState: "not_started",
    });
  } finally {
    f.cleanup();
  }
});

test("thread messages expose matching resolution evidence but omit it for deleted resolution messages", () => {
  const f = metadataFixture();
  try {
    const resolved = f.service.resolveThread(
      agent(target),
      f.thread.threadId,
      {
        explanation: "Already fixed in the current implementation",
        evidence: ["src/main.ts#L2", "notes://resolution"],
        fileId: f.fileId,
        assignmentEpoch: 1,
      },
      m(1),
    );
    const withResolution: any = f.service.getThread(operator, f.thread.threadId);
    expect(withResolution.messages[0]).not.toHaveProperty("resolution");
    expect(
      withResolution.messages.find((message: any) => message.id === resolved.messageId)?.resolution,
    ).toEqual({
      fileId: f.fileId,
      evidence: ["src/main.ts#L2", "notes://resolution"],
      addressedVersion: 1,
    });

    f.service.editMessage(agent(target), resolved.messageId, null, m(1), 1);
    const afterDelete: any = f.service.getThread(operator, f.thread.threadId);
    const deletedResolution = afterDelete.messages.find(
      (message: any) => message.id === resolved.messageId,
    );
    expect(deletedResolution).toMatchObject({ body: null, deleted: 1 });
    expect(deletedResolution).not.toHaveProperty("resolution");
  } finally {
    f.cleanup();
  }
});

test("files metadata returns source and diff stats with conservative open-thread counts", async () => {
  const f = metadataFixture();
  try {
    const diff = f.service.capture(
      operator,
      f.reviewId,
      {
        workspaceId,
        worktreeId,
        mode: "staged",
        base: null,
        head: null,
        capturedAt: new Date().toISOString(),
        files: [
          {
            oldPath: "src/main.ts",
            newPath: "src/main.ts",
            change: "modified",
            oldText: "one\ntwo\nthree\n",
            newText: "one\nchanged\nthree\nfour\n",
          },
        ],
      },
      m(),
    );

    const sourceRows = (await reviewAction(
      f.ctx,
      "files",
      { reviewId: f.reviewId, snapshotId: f.snapshotId },
      f.service,
    )) as Array<any>;
    expect(sourceRows[0]).toMatchObject({
      id: f.fileId,
      stats: { added: 0, deleted: 0, openThreads: 1 },
    });
    expect(sourceRows[0]).not.toHaveProperty("newText");

    const diffRows = (await reviewAction(
      f.ctx,
      "files",
      { reviewId: f.reviewId, snapshotId: diff.snapshotId },
      f.service,
    )) as Array<any>;
    expect(diffRows[0]).toMatchObject({
      id: diff.files[0],
      stats: { added: 2, deleted: 1, openThreads: 1 },
    });
    expect(JSON.stringify(diffRows[0])).not.toContain("one\ntwo\nthree");
    await expect(reviewAction({ ...f.ctx, ownerId: "foreign" }, "files", { reviewId: f.reviewId, snapshotId: diff.snapshotId }, f.service)).rejects.toThrow("unavailable");
    await expect(reviewAction({ ...f.ctx, workspaceId: "foreign" }, "files", { reviewId: f.reviewId, snapshotId: diff.snapshotId }, f.service)).rejects.toThrow("unavailable");
    expect(f.service.listThreads(agent(nextTarget), f.reviewId)).toEqual([]);
    mkdirSync(join(f.dir, "src"));
    symlinkSync("/etc/hosts", join(f.dir, "src/main.ts"));
    const retained: any = await reviewAction(f.ctx, "review", { reviewId: f.reviewId }, f.service);
    expect(retained.id).toBe(f.reviewId);
    expect(retained.gitAvailable).toBe(false);
    f.service.deleteThread(operator, f.thread.threadId, m(1));
    const afterDelete: any = await reviewAction(f.ctx, "files", { reviewId: f.reviewId, snapshotId: diff.snapshotId }, f.service);
    expect(afterDelete[0].stats.openThreads).toBe(0);
  } finally {
    f.cleanup();
  }
});
