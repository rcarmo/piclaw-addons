import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewService } from "./dispatch.js";
import type {
  LocalTarget,
  ReviewIdentity,
  SourceCapture,
} from "./contracts.js";

let fixtureSerial = 0;

function createFixture() {
  const serial = ++fixtureSerial;
  const workspaceId = `workspace:${serial}`;
  const worktreeId = `worktree:${serial}`;
  const dir = mkdtempSync(join(tmpdir(), `code-review-delivery-${serial}-`));
  const path = join(dir, "reviews.db");
  let store = new ReviewService(path);
  let closed = false;
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
    label: "Worker",
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

  const reviewId = store.createReview(
    operator,
    {
      workspaceId,
      worktreeId,
      title: "Delivery acceptance",
      focusPath: "src/main.ts",
      target,
    },
    mutation(),
  ).reviewId;

  const capture: SourceCapture = {
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
        newText: "alpha\nbeta\ngamma\n",
        fileIdentity: `inode:${serial}`,
      },
    ],
  };
  const fileId = store.capture(operator, reviewId, capture, mutation()).files[0]!;
  const threads = [
    store.createThread(
      operator,
      reviewId,
      {
        fileId,
        side: "source",
        range: { startLine: 1, endLine: 1 },
        body: "Preserve the export",
      },
      mutation(),
    ),
    store.createThread(
      operator,
      reviewId,
      {
        fileId,
        side: "source",
        range: { startLine: 2, endLine: 2 },
        body: "Confirm the fallback path",
      },
      mutation(),
    ),
  ];

  const close = () => {
    if (closed) return;
    store.close();
    closed = true;
  };

  return {
    dir,
    path,
    operator,
    target,
    agent,
    reviewId,
    fileId,
    threads,
    mutation,
    store: () => store,
    selection() {
      return {
        target,
        items: threads.map((thread) => ({
          threadId: thread.threadId,
          version: thread.version,
        })),
      };
    },
    reopen() {
      close();
      store = new ReviewService(path);
      closed = false;
      return store;
    },
    cleanup() {
      close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("CR-175/176 slice: queue delivery claims once, stays busy, and does not resend after reopen", async () => {
  const f = createFixture();
  try {
    const dispatch = f.store().submit(
      f.operator,
      f.reviewId,
      f.selection(),
      f.mutation(),
    );
    let calls = 0;
    const bridge = {
      async enqueue(input: {
        target: { chatId: string; incarnation: string };
        content: string;
        mode: "queue";
      }) {
        calls++;
        expect(input.mode).toBe("queue");
        expect(input.target).toEqual({
          chatId: f.target.chatId,
          incarnation: f.target.incarnation,
        });
        expect(input.content).toContain(dispatch.dispatchId);
        await Bun.sleep(10);
        return { status: "accepted" as const, rowId: 701 };
      },
    };

    await Promise.all([
      f.store().deliver(f.operator, dispatch.dispatchId, bridge),
      f.store().deliver(f.operator, dispatch.dispatchId, bridge),
    ]);

    expect(calls).toBe(1);
    expect(f.store().inspectDispatch(f.operator, dispatch.dispatchId).attempts).toEqual([
      expect.objectContaining({
        id: dispatch.attemptId,
        number: 1,
        state: "accepted",
        host_row_id: 701,
      }),
    ]);
    expect(() =>
      f.store().submit(
        f.operator,
        f.reviewId,
        {
          target: f.target,
          items: [{ threadId: f.threads[0]!.threadId, version: 1 }],
        },
        f.mutation(),
      ),
    ).toThrow("outstanding work");

    const reopened = f.reopen();
    expect(reopened.inspectDispatch(f.operator, dispatch.dispatchId).attempts).toEqual([
      expect.objectContaining({
        id: dispatch.attemptId,
        number: 1,
        state: "accepted",
        host_row_id: 701,
      }),
    ]);

    let replayCalls = 0;
    await reopened.deliver(f.operator, dispatch.dispatchId, {
      async enqueue() {
        replayCalls++;
        return { status: "accepted" as const, rowId: 999 };
      },
    });
    expect(replayCalls).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("CR-180 slice: completed and blocked items persist independently from thread open or resolved state", async () => {
  const f = createFixture();
  try {
    const dispatch = f.store().submit(
      f.operator,
      f.reviewId,
      f.selection(),
      f.mutation(),
    );
    await f.store().deliver(f.operator, dispatch.dispatchId, {
      async enqueue() {
        return { status: "accepted" as const, rowId: 702 };
      },
    });

    const threadA = f.threads[0]!.threadId;
    const threadB = f.threads[1]!.threadId;

    f.store().updateWork(
      f.agent,
      dispatch.dispatchId,
      threadA,
      {
        state: "completed",
        itemVersion: 1,
        threadVersion: 1,
        assignmentEpoch: 1,
      },
      f.mutation(),
    );
    f.store().updateWork(
      f.agent,
      dispatch.dispatchId,
      threadB,
      {
        state: "blocked",
        itemVersion: 1,
        threadVersion: 1,
        assignmentEpoch: 1,
      },
      f.mutation(),
    );

    expect(f.store().getThread(f.operator, threadA).state).toBe("open");
    expect(f.store().getThread(f.operator, threadB).state).toBe("open");

    let reopened = f.reopen();
    const openState = reopened.inspectDispatch(f.operator, dispatch.dispatchId);
    expect(openState.items).toEqual([
      expect.objectContaining({
        thread_id: threadA,
        work_state: "completed",
        currentThreadState: "open",
        currentThreadVersion: 1,
      }),
      expect.objectContaining({
        thread_id: threadB,
        work_state: "blocked",
        currentThreadState: "open",
        currentThreadVersion: 1,
      }),
    ]);

    reopened.resolveThread(
      f.agent,
      threadA,
      {
        explanation: "Verified in the saved snapshot",
        fileId: f.fileId,
        assignmentEpoch: 1,
      },
      f.mutation(1),
    );

    reopened = f.reopen();
    const persisted = reopened.inspectDispatch(f.operator, dispatch.dispatchId);
    expect(persisted.items).toEqual([
      expect.objectContaining({
        thread_id: threadA,
        work_state: "completed",
        currentThreadState: "resolved",
        currentThreadVersion: 2,
      }),
      expect.objectContaining({
        thread_id: threadB,
        work_state: "blocked",
        currentThreadState: "open",
        currentThreadVersion: 1,
      }),
    ]);
    expect(reopened.getThread(f.operator, threadA).state).toBe("resolved");
    expect(reopened.getThread(f.operator, threadB).state).toBe("open");
  } finally {
    f.cleanup();
  }
});

test("CR-040/041 slice: rejected attempts get numbered retries, unknown attempts persist, and reopen does not replay them", async () => {
  const f = createFixture();
  try {
    const dispatch = f.store().submit(
      f.operator,
      f.reviewId,
      f.selection(),
      f.mutation(),
    );

    let rejectedCalls = 0;
    await f.store().deliver(f.operator, dispatch.dispatchId, {
      async enqueue() {
        rejectedCalls++;
        throw Object.assign(Error("denied"), {
          delivery: "rejected",
          code: "target_unavailable",
        });
      },
    });
    expect(rejectedCalls).toBe(1);

    let reopened = f.reopen();
    expect(reopened.inspectDispatch(f.operator, dispatch.dispatchId).attempts).toEqual([
      expect.objectContaining({
        id: dispatch.attemptId,
        number: 1,
        state: "rejected",
        error_code: "target_unavailable",
      }),
    ]);

    const retry = reopened.retry(f.operator, dispatch.dispatchId, f.mutation());
    expect(retry.dispatchId).toBe(dispatch.dispatchId);

    let unknownCalls = 0;
    await reopened.deliver(f.operator, dispatch.dispatchId, {
      async enqueue() {
        unknownCalls++;
        throw Error("host timeout after accept");
      },
    });
    expect(unknownCalls).toBe(1);

    reopened = f.reopen();
    expect(
      reopened.inspectDispatch(f.operator, dispatch.dispatchId).attempts.map((attempt) => ({
        id: attempt.id,
        number: attempt.number,
        state: attempt.state,
        error_code: attempt.error_code,
      })),
    ).toEqual([
      {
        id: dispatch.attemptId,
        number: 1,
        state: "rejected",
        error_code: "target_unavailable",
      },
      {
        id: retry.attemptId,
        number: 2,
        state: "unknown",
        error_code: "enqueue_failed",
      },
    ]);

    let replayCalls = 0;
    await reopened.deliver(f.operator, dispatch.dispatchId, {
      async enqueue() {
        replayCalls++;
        return { status: "accepted" as const, rowId: 703 };
      },
    });
    expect(replayCalls).toBe(0);
    expect(() => reopened.retry(f.operator, dispatch.dispatchId, f.mutation())).toThrow(
      "definitively rejected",
    );
  } finally {
    f.cleanup();
  }
});

test("CR-041 slice: manual reconciliation stays attached to the original dispatch across reopen", async () => {
  const f = createFixture();
  try {
    const dispatch = f.store().submit(
      f.operator,
      f.reviewId,
      f.selection(),
      f.mutation(),
    );
    await f.store().deliver(f.operator, dispatch.dispatchId, {
      async enqueue() {
        throw Error("acknowledgement lost");
      },
    });

    let reopened = f.reopen();
    const reconcile = reopened.reconcile(
      f.operator,
      dispatch.dispatchId,
      {
        decision: "accepted",
        evidence: "Matched host receipt row 88",
        hostRowId: 88,
        attemptId: dispatch.attemptId,
      },
      f.mutation(),
    );
    expect(reconcile).toEqual({
      dispatchId: dispatch.dispatchId,
      attemptId: dispatch.attemptId,
    });

    const events = (
      reopened.events(f.operator, f.reviewId) as Array<{
        dispatch_id: string | null;
        kind: string;
        data_json: string;
      }>
    )
      .filter((event) => event.dispatch_id === dispatch.dispatchId)
      .map((event) => ({
        dispatch_id: event.dispatch_id,
        kind: event.kind,
        data: JSON.parse(event.data_json),
      }));
    expect(events).toEqual([
      {
        dispatch_id: dispatch.dispatchId,
        kind: "dispatch.prepared",
        data: { count: 2 },
      },
      {
        dispatch_id: dispatch.dispatchId,
        kind: "dispatch.unknown",
        data: {
          attemptId: dispatch.attemptId,
          hostRow: null,
          errorCode: "enqueue_failed",
        },
      },
      {
        dispatch_id: dispatch.dispatchId,
        kind: "dispatch.reconciled",
        data: {
          attemptId: dispatch.attemptId,
          decision: "accepted",
          evidence: "Matched host receipt row 88",
        },
      },
    ]);

    reopened = f.reopen();
    expect(reopened.inspectDispatch(f.operator, dispatch.dispatchId).attempts).toEqual([
      expect.objectContaining({
        id: dispatch.attemptId,
        number: 1,
        state: "accepted",
        host_row_id: 88,
        error_code: "enqueue_failed",
      }),
    ]);
    expect(reopened.listDispatches(f.operator, f.reviewId)).toEqual([
      expect.objectContaining({ id: dispatch.dispatchId, review_id: f.reviewId }),
    ]);

    let replayCalls = 0;
    await reopened.deliver(f.operator, dispatch.dispatchId, {
      async enqueue() {
        replayCalls++;
        return { status: "accepted" as const, rowId: 999 };
      },
    });
    expect(replayCalls).toBe(0);
  } finally {
    f.cleanup();
  }
});
