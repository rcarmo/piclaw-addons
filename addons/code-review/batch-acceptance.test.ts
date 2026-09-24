import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewService } from "./dispatch.js";
import {
  ReviewError,
  type LocalTarget,
  type ReviewIdentity,
  type SourceCapture,
} from "./contracts.js";

const MAIN_BODY = "Selected main-thread guidance";
const UTIL_BODY = "Selected util-thread guidance";
const OTHER_BODY = "Unselected thread that must stay untouched";
const DRAFT_BODY = "Private draft that must never be dispatched";
const MAIN_REPLY = "Main file evidence stays on the main thread";
const MAIN_RESOLUTION = "Resolved on the saved main snapshot";
const UTIL_REPLY = "Blocked on the util thread only";

let fixtureSerial = 0;

function expectReviewError(
  run: () => unknown,
  code: string,
  messageFragment: string,
) {
  try {
    run();
    throw new Error("Expected ReviewError");
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewError);
    expect((error as ReviewError).code).toBe(code);
    expect((error as Error).message).toContain(messageFragment);
  }
}

function createFixture() {
  const serial = ++fixtureSerial;
  const workspaceId = `workspace:batch:${serial}`;
  const worktreeId = `worktree:batch:${serial}`;
  const dir = mkdtempSync(join(tmpdir(), `code-review-batch-${serial}-`));
  const path = join(dir, "reviews.db");
  const store = new ReviewService(path);
  let request = 0;

  const operator: ReviewIdentity = {
    ownerId: `owner:${serial}`,
    actorId: `operator:${serial}`,
    kind: "operator",
    workspaceId,
  };
  const target: LocalTarget = {
    chatId: `web:worker:${serial}`,
    incarnation: `chat:${serial}`,
    label: "Implementation",
  };
  const otherTarget: LocalTarget = {
    chatId: `web:reviewer:${serial}`,
    incarnation: `chat:other:${serial}`,
    label: "Reviewer",
  };
  const agent: ReviewIdentity = {
    ownerId: operator.ownerId,
    actorId: `agent:${serial}`,
    kind: "agent",
    chatId: target.chatId,
    chatIncarnation: target.incarnation,
  };
  const mutation = (expectedVersion?: number, requestId?: string) => ({
    requestId: requestId ?? `req-${serial}-${++request}`,
    expectedVersion,
  });
  const capture = (files: SourceCapture["files"]): SourceCapture => ({
    workspaceId,
    worktreeId,
    mode: "source",
    base: null,
    head: null,
    capturedAt: new Date().toISOString(),
    files,
  });

  const review = store.createFromCapture(
    operator,
    {
      title: "Batch acceptance",
      focusPath: "src/main.ts",
      target,
    },
    capture([
      {
        oldPath: null,
        newPath: "src/main.ts",
        change: "source",
        oldText: null,
        newText: "export const main = true;\nexport function keepMain() {\n  return 'main';\n}\n",
        fileIdentity: `inode:main:${serial}`,
      },
      {
        oldPath: null,
        newPath: "src/util.ts",
        change: "source",
        oldText: null,
        newText: "export function utilFallback() {\n  return 'util';\n}\n",
        fileIdentity: `inode:util:${serial}`,
      },
    ]),
    mutation(),
  );
  const reviewId = review.reviewId;
  const mainFileId = review.files[0]!;
  const utilFileId = review.files[1]!;

  const mainThread = store.createThread(
    operator,
    reviewId,
    {
      fileId: mainFileId,
      side: "source",
      range: { startLine: 1, endLine: 1 },
      body: MAIN_BODY,
    },
    mutation(),
  );
  const utilThread = store.createThread(
    operator,
    reviewId,
    {
      fileId: utilFileId,
      side: "source",
      range: { startLine: 1, endLine: 1 },
      body: UTIL_BODY,
    },
    mutation(),
  );
  const otherThread = store.createThread(
    operator,
    reviewId,
    {
      fileId: mainFileId,
      side: "source",
      range: { startLine: 2, endLine: 2 },
      body: OTHER_BODY,
    },
    mutation(),
  );
  const draft = store.saveDraft(
    operator,
    reviewId,
    { threadId: mainThread.threadId, body: DRAFT_BODY },
    mutation(),
  );

  const counts = () => ({
    dispatches:
      store.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM dispatches")
        ?.n ?? 0,
    items:
      store.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM dispatch_items",
      )?.n ?? 0,
    attempts:
      store.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM attempts")
        ?.n ?? 0,
  });
  const threadBodies = (threadId: string) =>
    store.getThread(operator, threadId).messages.map((message) => message.body);
  const selection = (...threadIds: string[]) => ({
    target,
    items: threadIds.map((threadId) => ({
      threadId,
      version: store.getThread(operator, threadId).version,
    })),
  });
  const createOtherReviewThread = () => {
    const otherReview = store.createFromCapture(
      operator,
      {
        title: "Other review",
        focusPath: "src/other.ts",
        target,
      },
      capture([
        {
          oldPath: null,
          newPath: "src/other.ts",
          change: "source",
          oldText: null,
          newText: "export const otherReview = true;\n",
          fileIdentity: `inode:other:${serial}`,
        },
      ]),
      mutation(),
    );
    const fileId = otherReview.files[0]!;
    const thread = store.createThread(
      operator,
      otherReview.reviewId,
      {
        fileId,
        side: "source",
        range: { startLine: 1, endLine: 1 },
        body: "Other review thread",
      },
      mutation(),
    );
    return { reviewId: otherReview.reviewId, fileId, thread };
  };

  return {
    dir,
    store,
    operator,
    target,
    otherTarget,
    agent,
    reviewId,
    mainFileId,
    utilFileId,
    mainThread,
    utilThread,
    otherThread,
    draft,
    mutation,
    counts,
    threadBodies,
    selection,
    createOtherReviewThread,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function expectThread(
  store: ReviewService,
  who: ReviewIdentity,
  threadId: string,
  input: {
    state: "open" | "resolved";
    version: number;
    fileId: string;
    bodies: Array<string | null>;
  },
) {
  const thread = store.getThread(who, threadId);
  expect(thread.state).toBe(input.state);
  expect(thread.version).toBe(input.version);
  expect(thread.source.fileId).toBe(input.fileId);
  expect(thread.messages.map((message) => message.body)).toEqual(input.bodies);
}

test("CR-104/105 batch preview and send preserve item order, snapshot identity and per-thread outcomes", async () => {
  const f = createFixture();
  try {
    const input = f.selection(f.utilThread.threadId, f.mainThread.threadId);
    const preview = f.store.preview(f.operator, f.reviewId, input);

    expect(preview.target).toEqual(f.target);
    expect(preview.items.map((item) => item.threadId)).toEqual([
      f.utilThread.threadId,
      f.mainThread.threadId,
    ]);
    expect(preview.items.map((item) => item.version)).toEqual([1, 1]);
    expect(preview.items.map((item) => item.anchor.snapshotFileId)).toEqual([
      f.utilFileId,
      f.mainFileId,
    ]);
    expect(JSON.stringify(preview)).not.toContain(OTHER_BODY);
    expect(JSON.stringify(preview)).not.toContain(DRAFT_BODY);
    expect(f.store.listDispatches(f.operator, f.reviewId)).toEqual([]);
    expect(f.counts()).toEqual({ dispatches: 0, items: 0, attempts: 0 });

    const submitted = f.store.submit(
      f.operator,
      f.reviewId,
      input,
      f.mutation(undefined, `batch-submit:${f.reviewId}`),
    );
    const prepared = f.store.inspectDispatch(f.operator, submitted.dispatchId);

    expect(f.counts()).toEqual({ dispatches: 1, items: 2, attempts: 1 });
    expect(prepared.items.map((item: any) => item.thread_id)).toEqual([
      f.utilThread.threadId,
      f.mainThread.threadId,
    ]);
    expect(prepared.items.map((item: any) => item.snapshot_file_id)).toEqual([
      f.utilFileId,
      f.mainFileId,
    ]);
    expect(JSON.stringify(prepared)).not.toContain(OTHER_BODY);
    expect(JSON.stringify(prepared)).not.toContain(DRAFT_BODY);

    let queueCalls = 0;
    let queuedContent = "";
    const delivered = await f.store.deliver(f.operator, submitted.dispatchId, {
      async enqueue(input) {
        queueCalls++;
        queuedContent = input.content;
        expect(input.mode).toBe("queue");
        expect(input.target).toEqual({
          chatId: f.target.chatId,
          incarnation: f.target.incarnation,
        });
        return { status: "accepted" as const, rowId: 4105 };
      },
    });

    expect(queueCalls).toBe(1);
    expect(queuedContent).toContain(f.reviewId);
    expect(queuedContent).toContain(submitted.dispatchId);
    expect(queuedContent).not.toContain(MAIN_BODY);
    expect(queuedContent).not.toContain(UTIL_BODY);
    expect(queuedContent).not.toContain(OTHER_BODY);
    expect(queuedContent).not.toContain(DRAFT_BODY);
    expect(delivered.attempts).toEqual([
      expect.objectContaining({
        id: submitted.attemptId,
        number: 1,
        state: "accepted",
        host_row_id: 4105,
      }),
    ]);
    expect(f.counts()).toEqual({ dispatches: 1, items: 2, attempts: 1 });

    const agentView = f.store.inspectDispatch(f.agent, submitted.dispatchId);
    expect(agentView.items.map((item: any) => item.thread_id)).toEqual([
      f.utilThread.threadId,
      f.mainThread.threadId,
    ]);
    expect(agentView.items.map((item: any) => item.snapshot_file_id)).toEqual([
      f.utilFileId,
      f.mainFileId,
    ]);
    expect(JSON.stringify(agentView)).not.toContain(DRAFT_BODY);

    f.store.reply(
      f.agent,
      f.mainThread.threadId,
      MAIN_REPLY,
      f.mutation(1),
      1,
    );
    f.store.resolveThread(
      f.agent,
      f.mainThread.threadId,
      {
        explanation: MAIN_RESOLUTION,
        evidence: ["src/main.ts#L1"],
        fileId: f.mainFileId,
        assignmentEpoch: 1,
      },
      f.mutation(2),
    );
    f.store.updateWork(
      f.agent,
      submitted.dispatchId,
      f.mainThread.threadId,
      {
        state: "completed",
        itemVersion: 1,
        threadVersion: 3,
        assignmentEpoch: 1,
      },
      f.mutation(),
    );
    f.store.reply(
      f.agent,
      f.utilThread.threadId,
      UTIL_REPLY,
      f.mutation(1),
      1,
    );
    f.store.updateWork(
      f.agent,
      submitted.dispatchId,
      f.utilThread.threadId,
      {
        state: "blocked",
        itemVersion: 1,
        threadVersion: 2,
        assignmentEpoch: 1,
      },
      f.mutation(),
    );

    expectThread(f.store, f.operator, f.mainThread.threadId, {
      state: "resolved",
      version: 3,
      fileId: f.mainFileId,
      bodies: [MAIN_BODY, MAIN_REPLY, MAIN_RESOLUTION],
    });
    expectThread(f.store, f.operator, f.utilThread.threadId, {
      state: "open",
      version: 2,
      fileId: f.utilFileId,
      bodies: [UTIL_BODY, UTIL_REPLY],
    });
    expectThread(f.store, f.operator, f.otherThread.threadId, {
      state: "open",
      version: 1,
      fileId: f.mainFileId,
      bodies: [OTHER_BODY],
    });
    expect(f.threadBodies(f.otherThread.threadId)).toEqual([OTHER_BODY]);
    expect(
      (f.store.listDrafts(f.operator, f.reviewId) as Array<{ body: string }>).map(
        (draft) => draft.body,
      ),
    ).toEqual([DRAFT_BODY]);

    const finalDispatch = f.store.inspectDispatch(f.operator, submitted.dispatchId);
    expect(finalDispatch.items).toEqual([
      expect.objectContaining({
        thread_id: f.utilThread.threadId,
        snapshot_file_id: f.utilFileId,
        work_state: "blocked",
        currentThreadVersion: 2,
        currentThreadState: "open",
      }),
      expect.objectContaining({
        thread_id: f.mainThread.threadId,
        snapshot_file_id: f.mainFileId,
        work_state: "completed",
        currentThreadVersion: 3,
        currentThreadState: "resolved",
      }),
    ]);
    expect(finalDispatch.attempts).toHaveLength(1);
    expect(queueCalls).toBe(1);
  } finally {
    f.cleanup();
  }
});

test("CR-106/107/108 batch submission rejects the whole selection before any enqueue for changed, retargeted, deleted and cross-review items", () => {
  const cases = [
    {
      name: "changed version",
      arrange(f: ReturnType<typeof createFixture>) {
        const input = f.selection(f.mainThread.threadId, f.utilThread.threadId);
        f.store.reply(
          f.operator,
          f.utilThread.threadId,
          "Edited after preview",
          f.mutation(1),
        );
        return {
          input,
          code: "conflict",
          message: "record changed",
          assert() {
            expectThread(f.store, f.operator, f.mainThread.threadId, {
              state: "open",
              version: 1,
              fileId: f.mainFileId,
              bodies: [MAIN_BODY],
            });
            expectThread(f.store, f.operator, f.utilThread.threadId, {
              state: "open",
              version: 2,
              fileId: f.utilFileId,
              bodies: [UTIL_BODY, "Edited after preview"],
            });
          },
        };
      },
    },
    {
      name: "retargeted item",
      arrange(f: ReturnType<typeof createFixture>) {
        f.store.reassign(
          f.operator,
          f.utilThread.threadId,
          f.otherTarget,
          f.mutation(1),
        );
        return {
          input: {
            target: f.target,
            items: [
              { threadId: f.mainThread.threadId, version: 1 },
              { threadId: f.utilThread.threadId, version: 2 },
            ],
          },
          code: "target_mismatch",
          message: "reassign",
          assert() {
            expectThread(f.store, f.operator, f.mainThread.threadId, {
              state: "open",
              version: 1,
              fileId: f.mainFileId,
              bodies: [MAIN_BODY],
            });
            expect(f.store.getThread(f.operator, f.utilThread.threadId).target).toEqual(
              f.otherTarget,
            );
          },
        };
      },
    },
    {
      name: "deleted item",
      arrange(f: ReturnType<typeof createFixture>) {
        const input = f.selection(f.mainThread.threadId, f.utilThread.threadId);
        f.store.deleteThread(f.operator, f.utilThread.threadId, f.mutation(1));
        return {
          input,
          code: "not_found",
          message: "unavailable",
          assert() {
            expectThread(f.store, f.operator, f.mainThread.threadId, {
              state: "open",
              version: 1,
              fileId: f.mainFileId,
              bodies: [MAIN_BODY],
            });
            expect(
              f.store.database.get<{ state: string; version: number }>(
                "SELECT state,version FROM threads WHERE id=?",
                f.utilThread.threadId,
              ),
            ).toEqual({ state: "deleted", version: 2 });
          },
        };
      },
    },
    {
      name: "cross-review item",
      arrange(f: ReturnType<typeof createFixture>) {
        const other = f.createOtherReviewThread();
        return {
          input: {
            target: f.target,
            items: [
              { threadId: f.mainThread.threadId, version: 1 },
              { threadId: other.thread.threadId, version: 1 },
            ],
          },
          code: "not_found",
          message: "unavailable",
          assert() {
            expectThread(f.store, f.operator, f.mainThread.threadId, {
              state: "open",
              version: 1,
              fileId: f.mainFileId,
              bodies: [MAIN_BODY],
            });
            expect(f.store.getThread(f.operator, other.thread.threadId).source.fileId).toBe(
              other.fileId,
            );
          },
        };
      },
    },
  ] as const;

  for (const entry of cases) {
    const f = createFixture();
    try {
      const prepared = entry.arrange(f);
      const before = f.counts();

      expect(before).toEqual({ dispatches: 0, items: 0, attempts: 0 });
      expectReviewError(
        () => f.store.submit(f.operator, f.reviewId, prepared.input, f.mutation()),
        prepared.code,
        prepared.message,
      );
      expect(f.counts()).toEqual(before);
      expect(f.store.listDispatches(f.operator, f.reviewId)).toEqual([]);
      expectThread(f.store, f.operator, f.otherThread.threadId, {
        state: "open",
        version: 1,
        fileId: f.mainFileId,
        bodies: [OTHER_BODY],
      });
      expect(
        (f.store.listDrafts(f.operator, f.reviewId) as Array<{ body: string }>).map(
          (draft) => draft.body,
        ),
      ).toEqual([DRAFT_BODY]);
      prepared.assert();
    } finally {
      f.cleanup();
    }
  }
});

test("CR-109 repeated batch submits reuse one intent, keep the frozen selection and reject conflicting payload reuse", async () => {
  const f = createFixture();
  try {
    const requestId = `repeat:${f.reviewId}`;
    const input = f.selection(f.mainThread.threadId, f.utilThread.threadId);

    const first = f.store.submit(
      f.operator,
      f.reviewId,
      input,
      f.mutation(undefined, requestId),
    );
    const second = f.store.submit(
      f.operator,
      f.reviewId,
      input,
      f.mutation(undefined, requestId),
    );

    expect(second).toEqual(first);
    expect(f.counts()).toEqual({ dispatches: 1, items: 2, attempts: 1 });

    let queueCalls = 0;
    await Promise.all([
      f.store.deliver(f.operator, first.dispatchId, {
        async enqueue() {
          queueCalls++;
          return { status: "accepted" as const, rowId: 4109 };
        },
      }),
      f.store.deliver(f.operator, first.dispatchId, {
        async enqueue() {
          queueCalls++;
          return { status: "accepted" as const, rowId: 9999 };
        },
      }),
    ]);

    expect(queueCalls).toBe(1);
    expect(
      f.store.inspectDispatch(f.operator, first.dispatchId).attempts,
    ).toEqual([
      expect.objectContaining({
        id: first.attemptId,
        number: 1,
        state: "accepted",
        host_row_id: 4109,
      }),
    ]);

    expectReviewError(
      () =>
        f.store.submit(
          f.operator,
          f.reviewId,
          {
            target: f.target,
            items: [
              { threadId: f.mainThread.threadId, version: 1 },
              { threadId: f.otherThread.threadId, version: 1 },
            ],
          },
          f.mutation(undefined, requestId),
        ),
      "conflict",
      "different action or payload",
    );

    expect(f.counts()).toEqual({ dispatches: 1, items: 2, attempts: 1 });
    expect(
      f.store.inspectDispatch(f.operator, first.dispatchId).items.map(
        (item: any) => item.thread_id,
      ),
    ).toEqual([f.mainThread.threadId, f.utilThread.threadId]);
    expectThread(f.store, f.operator, f.otherThread.threadId, {
      state: "open",
      version: 1,
      fileId: f.mainFileId,
      bodies: [OTHER_BODY],
    });
  } finally {
    f.cleanup();
  }
});

test("CR-110 stale selection detected after intent creation is rejected before delivery without partial enqueue", async () => {
  const f = createFixture();
  try {
    const submitted = f.store.submit(
      f.operator,
      f.reviewId,
      f.selection(f.mainThread.threadId, f.utilThread.threadId),
      f.mutation(),
    );

    expect(f.counts()).toEqual({ dispatches: 1, items: 2, attempts: 1 });
    f.store.deleteThread(f.operator, f.utilThread.threadId, f.mutation(1));

    let queueCalls = 0;
    const delivered = await f.store.deliver(f.operator, submitted.dispatchId, {
      async enqueue() {
        queueCalls++;
        return { status: "accepted" as const, rowId: 0 };
      },
    });

    expect(queueCalls).toBe(0);
    expect(f.counts()).toEqual({ dispatches: 1, items: 2, attempts: 1 });
    expect(delivered.attempts).toEqual([
      expect.objectContaining({
        id: submitted.attemptId,
        number: 1,
        state: "rejected",
        error_code: "selection_changed",
      }),
    ]);
    expect(delivered.items).toEqual([
      expect.objectContaining({
        thread_id: f.mainThread.threadId,
        work_state: "not_started",
        currentThreadVersion: 1,
        currentThreadState: "open",
      }),
      expect.objectContaining({
        thread_id: f.utilThread.threadId,
        work_state: "superseded",
        unavailable: true,
      }),
    ]);
    expectThread(f.store, f.operator, f.mainThread.threadId, {
      state: "open",
      version: 1,
      fileId: f.mainFileId,
      bodies: [MAIN_BODY],
    });
    expectThread(f.store, f.operator, f.otherThread.threadId, {
      state: "open",
      version: 1,
      fileId: f.mainFileId,
      bodies: [OTHER_BODY],
    });
    expect(
      (f.store.listDrafts(f.operator, f.reviewId) as Array<{ body: string }>).map(
        (draft) => draft.body,
      ),
    ).toEqual([DRAFT_BODY]);
  } finally {
    f.cleanup();
  }
});
