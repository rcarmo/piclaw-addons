import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LocalTarget, ReviewIdentity } from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";
import { SourceReader } from "./source.js";

let serial = 0;

interface CreatedReview {
  reviewId: string;
  files: string[];
}

interface CreatedThread {
  threadId: string;
  messageId: string;
  version: number;
}

interface ReplyReceipt {
  threadId: string;
  messageId: string;
  version: number;
}

interface DispatchView {
  id: string;
  attempts: Array<{ state: string; host_row_id: number | null }>;
  items: Array<{
    thread_id: string;
    work_state: string;
    currentThreadState: string;
    currentThreadVersion: number;
  }>;
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trimEnd();
}

function assertIntegrity(service: ReviewService) {
  expect(
    service.database.get<{ foreign_keys: number }>("PRAGMA foreign_keys")
      ?.foreign_keys,
  ).toBe(1);
  expect(service.database.all<Record<string, unknown>>("PRAGMA foreign_key_check")).toEqual(
    [],
  );
}

function createFixture() {
  const id = ++serial;
  const root = mkdtempSync(join(tmpdir(), `code-review-concurrency-${id}-`));
  const workspace = join(root, "workspace");
  const storeDir = join(root, "addon-data");
  const storePath = join(storeDir, "reviews.db");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(
    join(workspace, "src/main.ts"),
    [
      "export const value = 1;",
      "export function work() {",
      "  return value;",
      "}",
      "",
    ].join("\n"),
  );
  git(workspace, ["init", "--quiet", "--initial-branch=main"]);
  git(workspace, ["config", "user.name", "Code Review Tests"]);
  git(workspace, ["config", "user.email", "code-review@example.test"]);
  git(workspace, ["add", "src/main.ts"]);
  git(workspace, ["commit", "--quiet", "-m", "fixture"]);

  let service = new ReviewService(storePath);
  const extraServices = new Set<ReviewService>();
  const workspaceId = `workspace:${id}`;
  const operator: ReviewIdentity = {
    ownerId: `owner:${id}`,
    actorId: `operator:${id}`,
    kind: "operator",
    workspaceId,
  };
  const target: LocalTarget = {
    chatId: `web:worker:${id}`,
    incarnation: `chat:${id}`,
    label: "Worker",
  };
  const agent: ReviewIdentity = {
    ownerId: operator.ownerId,
    actorId: `agent:${id}`,
    kind: "agent",
    chatId: target.chatId,
    chatIncarnation: target.incarnation,
  };
  const hostTarget = {
    chatJid: target.chatId,
    incarnation: target.incarnation,
    label: target.label,
    agentName: `worker-${id}`,
    active: true,
  };
  const enqueueCalls: Array<{
    target: { chatJid: string; incarnation: string };
    content: string;
    mode: "queue";
  }> = [];
  let request = 0;
  let rowId = 800;

  const resolveTarget = async (input: {
    chatJid?: string;
    incarnation?: string;
    agentName?: string;
  }) => {
    if (input.chatJid && input.chatJid !== hostTarget.chatJid) return null;
    if (input.incarnation && input.incarnation !== hostTarget.incarnation)
      return null;
    if (input.agentName && input.agentName !== hostTarget.agentName)
      return null;
    return hostTarget;
  };

  const operatorCtx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: operator.ownerId,
    actorId: operator.actorId,
    kind: "operator",
    workspaceRoot: workspace,
    workspaceId,
    async listTargets() {
      return [hostTarget];
    },
    async resolveTarget(input) {
      return resolveTarget(input);
    },
    async enqueue(input) {
      enqueueCalls.push(input);
      return { status: "accepted" as const, rowId: ++rowId };
    },
  };

  const agentCtx: LocalContext = {
    ...operatorCtx,
    actorId: agent.actorId,
    kind: "agent",
    chatJid: target.chatId,
    chatIncarnation: target.incarnation,
    async enqueue() {
      throw new Error("unexpected agent enqueue");
    },
  };

  const mutation = (expectedVersion?: number, requestId?: string) => ({
    requestId: requestId ?? `req:${id}:${++request}`,
    expectedVersion,
  });

  const reader = new SourceReader(workspace, workspaceId);

  const createReview = async (title = `Review ${id}`): Promise<CreatedReview> => {
    const capture = await reader.capture({ path: "src/main.ts", mode: "source" });
    return service.createFromCapture(
      operator,
      { title, focusPath: "src/main.ts", target },
      capture,
      mutation(),
    ) as CreatedReview;
  };

  const createThread = async (body = "Root concern"): Promise<CreatedReview & CreatedThread> => {
    const review = await createReview();
    const thread = service.createThread(
      operator,
      review.reviewId,
      {
        fileId: review.files[0]!,
        side: "source",
        range: { startLine: 2, endLine: 2 },
        body,
      },
      mutation(),
    ) as CreatedThread;
    return { ...review, ...thread };
  };

  const repoState = () => ({
    bytes: readFileSync(join(workspace, "src/main.ts"), "utf8"),
    head: git(workspace, ["rev-parse", "HEAD"]),
    status: git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]),
    index: git(workspace, ["ls-files", "--stage"]),
  });

  const openService = () => {
    const next = new ReviewService(storePath);
    extraServices.add(next);
    return next;
  };

  const reopen = () => {
    service.close();
    service = new ReviewService(storePath);
    return service;
  };

  return {
    workspace,
    storePath,
    target,
    hostTarget,
    operator,
    agent,
    operatorCtx,
    agentCtx,
    enqueueCalls,
    mutation,
    reader,
    repoState,
    service: () => service,
    openService,
    reopen,
    createReview,
    createThread,
    cleanup() {
      for (const extra of extraServices) extra.close();
      service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("CR-070 same-key payload conflicts keep the original reply and receipt stable", async () => {
  const f = createFixture();
  try {
    const created = await f.createThread("Existing thread");
    const posted = f.service().reply(
      f.operator,
      created.threadId,
      "Keep this synchronous",
      { requestId: "K1", expectedVersion: 1 },
    ) as ReplyReceipt;

    const receiptBefore = f.service().database.get<{
      payload_hash: string;
      result_json: string;
      created_at: string;
    }>(
      "SELECT payload_hash,result_json,created_at FROM request_receipts WHERE owner_id=? AND actor_id=? AND request_id=?",
      f.operator.ownerId,
      f.operator.actorId,
      "K1",
    );
    expect(receiptBefore).toBeTruthy();
    expect(receiptBefore?.result_json).toContain(posted.messageId);
    expect(receiptBefore?.result_json).not.toContain("Keep this synchronous");

    const threadBefore = f.service().getThread(f.operator, created.threadId);
    const replyBodiesBefore = f.service().database.all<{ body: string | null }>(
      "SELECT body FROM message_revisions WHERE message_id=? ORDER BY version",
      posted.messageId,
    );
    expect(replyBodiesBefore).toEqual([{ body: "Keep this synchronous" }]);

    expect(() =>
      f.service().reply(
        f.operator,
        created.threadId,
        "Make this asynchronous",
        { requestId: "K1", expectedVersion: 1 },
      )
    ).toThrow("different action or payload");

    const threadAfter = f.service().getThread(f.operator, created.threadId);
    expect(
      threadAfter.messages.map((message) => ({
        id: message.id,
        ordinal: message.ordinal,
        body: message.body,
        deleted: message.deleted,
      })),
    ).toEqual(
      threadBefore.messages.map((message) => ({
        id: message.id,
        ordinal: message.ordinal,
        body: message.body,
        deleted: message.deleted,
      })),
    );
    expect(threadAfter.version).toBe(threadBefore.version);

    const receiptAfter = f.service().database.get<{
      payload_hash: string;
      result_json: string;
      created_at: string;
    }>(
      "SELECT payload_hash,result_json,created_at FROM request_receipts WHERE owner_id=? AND actor_id=? AND request_id=?",
      f.operator.ownerId,
      f.operator.actorId,
      "K1",
    );
    expect(receiptAfter).toEqual(receiptBefore);
    expect(
      f.service().database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM request_receipts WHERE owner_id=? AND actor_id=? AND request_id=?",
        f.operator.ownerId,
        f.operator.actorId,
        "K1",
      )?.n,
    ).toBe(1);
    expect(
      f.service().database.all<{ body: string | null }>(
        "SELECT body FROM message_revisions WHERE message_id=? ORDER BY version",
        posted.messageId,
      ),
    ).toEqual(replyBodiesBefore);

    expect(f.service().replyReceipt(f.operator, created.reviewId, "K1", created.threadId)).toEqual(
      {
        committed: true,
        threadId: created.threadId,
        messageId: posted.messageId,
      },
    );
    await expect(
      reviewAction(
        f.agentCtx,
        "replyReceipt",
        { reviewId: created.reviewId, requestId: "K1", threadId: created.threadId },
        f.service(),
      ),
    ).rejects.toThrow("Operator action");

    assertIntegrity(f.service());
  } finally {
    f.cleanup();
  }
});

test("CR-071 same-version replies on separate connections reject the stale writer with stable ordinals", async () => {
  const f = createFixture();
  try {
    const created = await f.createThread("Root concern");
    const competing = f.openService();

    const winner = f.service().reply(
      f.operator,
      created.threadId,
      "Operator reply wins this serial order",
      { requestId: "operator-reply", expectedVersion: 1 },
    ) as ReplyReceipt;
    expect(() =>
      competing.reply(
        f.agent,
        created.threadId,
        "Agent reply loses on the stale version",
        { requestId: "agent-reply", expectedVersion: 1 },
        1,
      )
    ).toThrow("record changed");

    const reopened = f.reopen();
    const thread = reopened.getThread(f.operator, created.threadId);
    expect(thread.version).toBe(2);
    expect(thread.messages.map((message) => message.ordinal)).toEqual([1, 2]);
    expect(thread.messages.map((message) => message.id)).toEqual([
      created.messageId,
      winner.messageId,
    ]);
    expect(thread.messages[1]).toMatchObject({
      id: winner.messageId,
      ordinal: 2,
      author_id: f.operator.actorId,
      body: "Operator reply wins this serial order",
    });
    expect(
      reopened.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id=?",
        created.threadId,
      )?.n,
    ).toBe(2);
    assertIntegrity(reopened);
  } finally {
    f.cleanup();
  }
});

test("CR-072 reply/delete interleavings preserve valid state in both winner orders", async () => {
  const deleteWins = createFixture();
  try {
    const created = await deleteWins.createThread("Delete target");
    const competing = deleteWins.openService();

    deleteWins.service().deleteThread(deleteWins.operator, created.threadId, {
      requestId: "delete-first",
      expectedVersion: 1,
    });
    expect(() =>
      competing.reply(
        deleteWins.agent,
        created.threadId,
        "Too late",
        { requestId: "reply-second", expectedVersion: 1 },
        1,
      )
    ).toThrow("unavailable");

    const reopened = deleteWins.reopen();
    expect(reopened.listThreads(deleteWins.operator, created.reviewId)).toEqual([]);
    expect(() => reopened.getThread(deleteWins.operator, created.threadId)).toThrow(
      "unavailable",
    );
    expect(() => reopened.getThread(deleteWins.agent, created.threadId)).toThrow(
      "unavailable",
    );
    expect(
      reopened.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id=?",
        created.threadId,
      )?.n,
    ).toBe(1);
    expect(
      reopened.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND deleted=0",
        created.threadId,
      )?.n,
    ).toBe(0);
    expect(
      reopened.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM message_revisions WHERE message_id IN (SELECT id FROM messages WHERE thread_id=?) AND body IS NOT NULL",
        created.threadId,
      )?.n,
    ).toBe(0);
    assertIntegrity(reopened);
  } finally {
    deleteWins.cleanup();
  }

  const replyWins = createFixture();
  try {
    const created = await replyWins.createThread("Reply target");
    const competing = replyWins.openService();

    const reply = replyWins.service().reply(
      replyWins.agent,
      created.threadId,
      "Still visible after the failed delete",
      { requestId: "reply-first", expectedVersion: 1 },
      1,
    ) as ReplyReceipt;
    expect(() =>
      competing.deleteThread(replyWins.operator, created.threadId, {
        requestId: "delete-second",
        expectedVersion: 1,
      })
    ).toThrow("record changed");

    const reopened = replyWins.reopen();
    const thread = reopened.getThread(replyWins.operator, created.threadId);
    expect(thread.state).toBe("open");
    expect(thread.version).toBe(2);
    expect(thread.messages.map((message) => message.ordinal)).toEqual([1, 2]);
    expect(thread.messages[1]).toMatchObject({
      id: reply.messageId,
      ordinal: 2,
      author_id: replyWins.agent.actorId,
      body: "Still visible after the failed delete",
      deleted: 0,
    });
    assertIntegrity(reopened);
  } finally {
    replyWins.cleanup();
  }
});

test("CR-073/179/180 comment CRUD, refresh, delivery, and resolve preserve Git state", async () => {
  const f = createFixture();
  try {
    const before = f.repoState();

    const created = await reviewAction(
      f.operatorCtx,
      "create",
      {
        path: "src/main.ts",
        target: { agentName: f.hostTarget.agentName },
        requestId: "create-review",
      },
      f.service(),
    ) as CreatedReview;

    const comment = await reviewAction(
      f.operatorCtx,
      "comment",
      {
        reviewId: created.reviewId,
        fileId: created.files[0],
        side: "source",
        range: { startLine: 2, endLine: 2 },
        body: "Keep the function stable",
        requestId: "comment-root",
      },
      f.service(),
    ) as CreatedThread;

    const agentReply = await reviewAction(
      f.agentCtx,
      "reply",
      {
        threadId: comment.threadId,
        body: "Acknowledged",
        expectedVersion: 1,
        assignmentEpoch: 1,
        requestId: "agent-reply",
      },
      f.service(),
    ) as ReplyReceipt;

    await reviewAction(
      f.operatorCtx,
      "edit",
      {
        messageId: comment.messageId,
        body: "Keep the function signature stable",
        expectedVersion: 1,
        requestId: "edit-root",
      },
      f.service(),
    );

    await reviewAction(
      f.agentCtx,
      "deleteMessage",
      {
        messageId: agentReply.messageId,
        confirm: true,
        expectedVersion: 1,
        assignmentEpoch: 1,
        requestId: "delete-agent-reply",
      },
      f.service(),
    );

    const afterCrud = f.service().getThread(f.operator, comment.threadId);
    expect(afterCrud.messages.map((message) => ({
      ordinal: message.ordinal,
      body: message.body,
      deleted: message.deleted,
    }))).toEqual([
      { ordinal: 1, body: "Keep the function signature stable", deleted: 0 },
      { ordinal: 2, body: null, deleted: 1 },
    ]);

    const refreshed = await reviewAction(
      f.operatorCtx,
      "capture",
      {
        reviewId: created.reviewId,
        source: { path: "src/main.ts", mode: "source" },
        requestId: "refresh-source",
      },
      f.service(),
    ) as { snapshotId: string; files: string[] };

    const queued = await reviewAction(
      f.operatorCtx,
      "send",
      {
        reviewId: created.reviewId,
        target: { chatId: f.target.chatId, incarnation: f.target.incarnation },
        items: [{ threadId: comment.threadId, version: afterCrud.version }],
        requestId: "queue-thread",
      },
      f.service(),
    ) as DispatchView;
    expect(queued.attempts[0]).toMatchObject({ state: "accepted" });

    const addressedVersion = f.service().getThread(f.operator, comment.threadId).version;
    const resolved = await reviewAction(
      f.operatorCtx,
      "resolve",
      {
        threadId: comment.threadId,
        explanation: "Verified against the refreshed snapshot",
        evidence: ["src/main.ts#L2"],
        fileId: refreshed.files[0],
        expectedVersion: addressedVersion,
        requestId: "resolve-thread",
      },
      f.service(),
    ) as ReplyReceipt;

    let reopened = f.reopen();
    const persistedDispatch = reopened.inspectDispatch(
      f.operator,
      queued.id,
    ) as DispatchView;
    expect(persistedDispatch.attempts[0]).toMatchObject({ state: "accepted" });
    expect(persistedDispatch.items).toEqual([
      expect.objectContaining({
        thread_id: comment.threadId,
        work_state: "not_started",
        currentThreadState: "resolved",
        currentThreadVersion: resolved.version,
      }),
    ]);

    const resolvedEvents = reopened.events(f.operator, created.reviewId) as Array<{
      kind: string;
      thread_id: string | null;
      data_json: string;
    }>;
    const resolvedEvent = resolvedEvents.find(
      (event) => event.kind === "thread.resolved" && event.thread_id === comment.threadId,
    );
    expect(resolvedEvent).toBeTruthy();
    expect(JSON.parse(resolvedEvent!.data_json)).toEqual(
      expect.objectContaining({
        messageId: resolved.messageId,
        fileId: refreshed.files[0],
        evidence: ["src/main.ts#L2"],
        addressedVersion,
      }),
    );

    await reviewAction(
      f.operatorCtx,
      "reopen",
      {
        threadId: comment.threadId,
        expectedVersion: resolved.version,
        requestId: "reopen-thread",
      },
      reopened,
    );

    reopened = f.reopen();
    const eventsAfterReopen = reopened.events(f.operator, created.reviewId) as Array<{
      kind: string;
      thread_id: string | null;
      data_json: string;
    }>;
    expect(
      eventsAfterReopen.filter(
        (event) => event.kind === "thread.resolved" && event.thread_id === comment.threadId,
      ),
    ).toHaveLength(1);
    expect(
      JSON.parse(
        eventsAfterReopen.find(
          (event) => event.kind === "thread.resolved" && event.thread_id === comment.threadId,
        )!.data_json,
      ),
    ).toEqual(
      expect.objectContaining({
        messageId: resolved.messageId,
        fileId: refreshed.files[0],
        evidence: ["src/main.ts#L2"],
        addressedVersion,
      }),
    );
    expect(
      eventsAfterReopen.some(
        (event) => event.kind === "thread.reopened" && event.thread_id === comment.threadId,
      ),
    ).toBe(true);

    expect(f.enqueueCalls).toHaveLength(1);
    expect(f.repoState()).toEqual(before);
    assertIntegrity(reopened);
  } finally {
    f.cleanup();
  }
});
