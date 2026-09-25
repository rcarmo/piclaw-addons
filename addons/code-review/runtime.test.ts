import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-runtime-"));
  writeFileSync(join(dir, "a.ts"), "const n = 1;\n");
  const service = new ReviewService(join(dir, "review.db"));
  const target = {
    chatJid: "web:worker",
    incarnation: "b1",
    label: "Worker",
    agentName: "worker",
    active: false,
  };
  let calls = 0;
  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: "o1",
    actorId: "human1",
    kind: "operator",
    workspaceRoot: dir,
    workspaceId: "workspace1",
    async listTargets() {
      return [target];
    },
    async resolveTarget(input) {
      return (!input.incarnation || input.incarnation === "b1") &&
        (input.chatJid === "web:worker" || input.agentName === "worker")
        ? target
        : null;
    },
    async enqueue(input) {
      calls++;
      expect(input.mode).toBe("queue");
      return { status: "accepted", rowId: 1 };
    },
  };
  return {
    dir,
    service,
    ctx,
    get calls() {
      return calls;
    },
    cleanup() {
      service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("CR-078/162/163 absent context and forged fields never initialise state", async () => {
  const f = fixture();
  try {
    await expect(reviewAction(null, "list", {}, f.service)).rejects.toThrow(
      "guarded operator action",
    );
    await expect(
      reviewAction(f.ctx, "list", { ownerId: "attacker" }, f.service),
    ).rejects.toThrow("Authority fields");
    expect(f.service.listReviews({ ...f.ctx })).toEqual([]);
  } finally {
    f.cleanup();
  }
});
test("CR-111/112/164 real API operations capture, comment, preview and queue", async () => {
  const f = fixture();
  try {
    const created: any = await reviewAction(
      f.ctx,
      "create",
      { path: "a.ts", target: { agentName: "worker" }, requestId: "create1" },
      f.service,
    );
    const file: any = await reviewAction(
      f.ctx,
      "file",
      { reviewId: created.reviewId, fileId: created.files[0] },
      f.service,
    );
    expect(file.new.lines[0].text).toBe("const n = 1;");
    expect(file.new.lines[0].html).toContain("tok-keyword");
    const comment: any = await reviewAction(
      f.ctx,
      "comment",
      {
        reviewId: created.reviewId,
        fileId: created.files[0],
        side: "source",
        range: { startLine: 1, endLine: 1 },
        body: "Keep number",
        requestId: "comment1",
      },
      f.service,
    );
    expect(f.calls).toBe(0);
    const input = {
      reviewId: created.reviewId,
      target: { chatId: "web:worker", incarnation: "b1" },
      items: [{ threadId: comment.threadId, version: 1 }],
      requestId: "send1",
    };
    await reviewAction(f.ctx, "preview", input, f.service);
    expect(f.calls).toBe(0);
    const d: any = await reviewAction(f.ctx, "send", input, f.service);
    expect(d.attempts[0].state).toBe("accepted");
    await reviewAction(f.ctx, "send", input, f.service);
    expect(f.calls).toBe(1);
    const agent: LocalContext = {
      ...f.ctx,
      kind: "agent",
      actorId: "agent1",
      chatJid: "web:worker",
      chatIncarnation: "b1",
      reference: { addonId: "code-review", intentId: d.id },
    };
    expect(
      (
        (await reviewAction(
          agent,
          "dispatch",
          { dispatchId: d.id },
          f.service,
        )) as any
      ).items.length,
    ).toBe(1);
    await expect(
      reviewAction(
        agent,
        "file",
        { reviewId: created.reviewId, fileId: created.files[0] },
        f.service,
      ),
    ).rejects.toThrow("Operator action");
    const reply: any = await reviewAction(
      agent,
      "reply",
      {
        threadId: comment.threadId,
        body: "Confirmed",
        expectedVersion: 1,
        assignmentEpoch: 1,
        requestId: "reply1",
      },
      f.service,
    );
    expect(reply.version).toBe(2);
  } finally {
    f.cleanup();
  }
});
test("CR-078 expired host scope after source capture cannot persist a review", async () => {
  const f = fixture();
  try {
    let checks = 0;
    const ctx = {
      ...f.ctx,
      async listTargets() {
        if (++checks > 1) throw Error("scope revoked");
        return f.ctx.listTargets();
      },
    };
    await expect(
      reviewAction(
        ctx,
        "create",
        { path: "a.ts", target: { agentName: "worker" }, requestId: "revoked" },
        f.service,
      ),
    ).rejects.toThrow("scope revoked");
    expect(f.service.listReviews(f.ctx)).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("CR-110 agent can report deleted queued items superseded through the real action adapter", async () => {
  const f = fixture();
  try {
    const r: any = await reviewAction(
      f.ctx,
      "create",
      { path: "a.ts", target: { agentName: "worker" }, requestId: "c1" },
      f.service,
    );
    const t: any = await reviewAction(
      f.ctx,
      "comment",
      {
        reviewId: r.reviewId,
        fileId: r.files[0],
        side: "source",
        body: "test",
        requestId: "t1",
      },
      f.service,
    );
    const d: any = await reviewAction(
      f.ctx,
      "send",
      {
        reviewId: r.reviewId,
        target: { chatId: "web:worker", incarnation: "b1" },
        items: [{ threadId: t.threadId, version: 1 }],
        requestId: "s1",
      },
      f.service,
    );
    await reviewAction(
      f.ctx,
      "deleteThread",
      {
        threadId: t.threadId,
        expectedVersion: 1,
        confirm: true,
        requestId: "x1",
      },
      f.service,
    );
    const agent: LocalContext = {
      ...f.ctx,
      kind: "agent",
      actorId: "agent1",
      chatJid: "web:worker",
      chatIncarnation: "b1",
      reference: { addonId: "code-review", intentId: d.id },
    };
    const outcome: any = await reviewAction(
      agent,
      "work",
      {
        dispatchId: d.id,
        threadId: t.threadId,
        state: "superseded",
        itemVersion: 1,
        threadVersion: 1,
        assignmentEpoch: 1,
        requestId: "w1",
      },
      f.service,
    );
    expect(outcome.state).toBe("superseded");
    await expect(
      reviewAction(agent, "thread", { threadId: t.threadId }, f.service),
    ).rejects.toThrow("unavailable");
  } finally {
    f.cleanup();
  }
});

test("CR-169/177 create is atomic and repeated request does not create a second snapshot", async () => {
  const f = fixture();
  try {
    const input = {
      path: "a.ts",
      target: { agentName: "worker" },
      requestId: "create1",
    };
    const first: any = await reviewAction(f.ctx, "create", input, f.service);
    writeFileSync(join(f.dir, "a.ts"), "changed\n");
    const second = await reviewAction(f.ctx, "create", input, f.service);
    expect(second).toEqual(first);
    expect(f.service.listSnapshots(f.ctx, first.reviewId)).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

test("CR-069 reply receipts are body-free and scoped to the current operator, review and thread", async () => {
  const f = fixture();
  try {
    const created: any = await reviewAction(f.ctx, "create", {
      path: "a.ts", target: { agentName: "worker" }, requestId: "receipt-create",
    }, f.service);
    const other: any = await reviewAction(f.ctx, "create", {
      path: "a.ts", target: { agentName: "worker" }, requestId: "receipt-other",
    }, f.service);
    const thread: any = await reviewAction(f.ctx, "comment", {
      reviewId: created.reviewId, fileId: created.files[0], side: "source", body: "Original guidance", requestId: "receipt-thread",
    }, f.service);
    const input = { reviewId: created.reviewId, threadId: thread.threadId, requestId: "receipt-reply" };
    expect(await reviewAction(f.ctx, "replyReceipt", input, f.service)).toEqual({ committed: false });
    const posted: any = await reviewAction(f.ctx, "reply", {
      threadId: thread.threadId, body: "Secret reply contents", expectedVersion: 1, requestId: input.requestId,
    }, f.service);
    const receipt = await reviewAction(f.ctx, "replyReceipt", input, f.service);
    expect(receipt).toEqual({ committed: true, threadId: thread.threadId, messageId: posted.messageId });
    expect(JSON.stringify(receipt)).not.toContain("Secret reply contents");
    expect(await reviewAction({ ...f.ctx, actorId: "another-operator" }, "replyReceipt", input, f.service)).toEqual({ committed: false });
    await expect(reviewAction(f.ctx, "replyReceipt", { ...input, reviewId: other.reviewId }, f.service)).rejects.toThrow("unavailable");
    const agent = { ...f.ctx, kind: "agent" as const, chatJid: "web:worker", chatIncarnation: "b1" };
    await expect(reviewAction(agent, "replyReceipt", input, f.service)).rejects.toThrow("Operator action");
    await expect(reviewAction(agent, "replyReceipt", { ...input, threadId: "thread_missing" }, f.service)).rejects.toThrow("Operator action");
    await reviewAction(f.ctx, "deleteMessage", { messageId: posted.messageId, expectedVersion: 1, requestId: "receipt-delete", confirm: true }, f.service);
    expect(await reviewAction(f.ctx, "replyReceipt", input, f.service)).toEqual(receipt);
  } finally { f.cleanup(); }
});
