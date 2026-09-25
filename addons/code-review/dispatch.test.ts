import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewService } from "./dispatch.js";
import type {
  ReviewIdentity,
  LocalTarget,
  SourceCapture,
} from "./contracts.js";
const human: ReviewIdentity = {
  ownerId: "o:1",
  actorId: "h:1",
  kind: "operator",
};
const target: LocalTarget = {
  chatId: "web:worker",
  incarnation: "b1",
  label: "Worker",
};
const agent: ReviewIdentity = {
  ownerId: human.ownerId,
  actorId: "a:1",
  kind: "agent",
  chatId: target.chatId,
  chatIncarnation: target.incarnation,
};
let sequence = 0;
const m = (expectedVersion?: number) => ({
  requestId: `r-${++sequence}`,
  expectedVersion,
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-dispatch-")),
    path = join(dir, "reviews.db"),
    store = new ReviewService(path);
  const reviewId = store.createReview(
    human,
    {
      workspaceId: "w1",
      worktreeId: "t1",
      title: "Test",
      focusPath: "a.ts",
      target,
    },
    m(),
  ).reviewId;
  const cap: SourceCapture = {
    workspaceId: "w1",
    worktreeId: "t1",
    mode: "source",
    base: null,
    head: null,
    capturedAt: new Date().toISOString(),
    files: [
      {
        oldPath: null,
        newPath: "a.ts",
        change: "source",
        oldText: null,
        newText: "one\ntwo\n",
      },
    ],
  };
  const fileId = store.capture(human, reviewId, cap, m()).files[0]!;
  const threads = ["A", "B"].map((body) =>
    store.createThread(human, reviewId, { fileId, side: "source", body }, m()),
  );
  const input = {
    target,
    items: threads.map((t) => ({ threadId: t.threadId, version: t.version })),
  };
  return {
    store,
    dir,
    path,
    reviewId,
    fileId,
    threads,
    input,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("CR-033/034/104/109/176 preview is inert and one batch is claimed once", async () => {
  const f = fixture();
  try {
    expect(f.store.preview(human, f.reviewId, f.input).items).toHaveLength(2);
    expect(f.store.listDispatches(human)).toHaveLength(0);
    const request = m(),
      d = f.store.submit(human, f.reviewId, f.input, request);
    expect(f.store.submit(human, f.reviewId, f.input, request)).toEqual(d);
    let calls = 0;
    const bridge = {
      async enqueue(input: any) {
        calls++;
        expect(input.mode).toBe("queue");
        expect(input.content).toContain(d.dispatchId);
        expect(input.content).not.toContain('"A"');
        await Bun.sleep(10);
        return { status: "accepted" as const, rowId: 10 };
      },
    };
    await Promise.all([
      f.store.deliver(human, d.dispatchId, bridge),
      f.store.deliver(human, d.dispatchId, bridge),
    ]);
    expect(calls).toBe(1);
    const state = f.store.inspectDispatch(human, d.dispatchId);
    expect(state.attempts[0]?.state).toBe("accepted");
    expect(state.items).toHaveLength(2);
    expect(
      f.store.listThreads(human, f.reviewId).every((t) => t.state === "open"),
    ).toBe(true);
    expect(() => f.store.submit(human, f.reviewId, f.input, m())).toThrow(
      "outstanding work",
    );
  } finally {
    f.cleanup();
  }
});
test("prepared intents are invisible to agents and changed selections cannot enqueue", async () => {
  const f = fixture();
  try {
    const d = f.store.submit(
      human,
      f.reviewId,
      { ...f.input, summary: "private pending summary" },
      m(),
    );
    expect(() => f.store.inspectDispatch(agent, d.dispatchId)).toThrow(
      "unavailable",
    );
    expect(f.store.listDispatches(agent)).toEqual([]);
    f.store.reassign(
      human,
      f.threads[0]!.threadId,
      { chatId: "web:other", incarnation: "b2", label: "Other" },
      m(1),
    );
    let calls = 0;
    await f.store.deliver(human, d.dispatchId, {
      async enqueue() {
        calls++;
        return { status: "accepted", rowId: 1 };
      },
    });
    expect(calls).toBe(0);
    expect(
      f.store.inspectDispatch(human, d.dispatchId).attempts[0],
    ).toMatchObject({ state: "rejected", error_code: "selection_changed" });
    const next = f.store.submit(
      human,
      f.reviewId,
      {
        target: { chatId: "web:other", incarnation: "b2", label: "Other" },
        items: [{ threadId: f.threads[0]!.threadId, version: 2 }],
      },
      m(),
    );
    expect(next.dispatchId).not.toBe(d.dispatchId);
  } finally {
    f.cleanup();
  }
});

test("old dispatched target sees only receipt metadata after reassignment", async () => {
  const f = fixture();
  try {
    const d = f.store.submit(
      human,
      f.reviewId,
      { ...f.input, summary: "old guidance summary" },
      m(),
    );
    await f.store.deliver(human, d.dispatchId, {
      async enqueue() {
        return { status: "accepted", rowId: 1 };
      },
    });
    f.store.reassign(
      human,
      f.threads[0]!.threadId,
      { chatId: "web:other", incarnation: "b2", label: "Other" },
      m(1),
    );
    expect(f.store.inspectDispatch(agent, d.dispatchId).summary).toBe("");
    expect(f.store.inspectDispatch(agent, d.dispatchId).items[0]).toMatchObject(
      { unavailable: true },
    );
    expect(JSON.stringify(f.store.listDispatches(agent))).not.toContain(
      "old guidance summary",
    );
    expect(() => f.store.getThread(agent, f.threads[0]!.threadId)).toThrow(
      "unavailable",
    );
    const next = f.store.submit(
      human,
      f.reviewId,
      {
        target: { chatId: "web:other", incarnation: "b2", label: "Other" },
        items: [{ threadId: f.threads[0]!.threadId, version: 2 }],
      },
      m(),
    );
    expect(next.dispatchId).toBeTruthy();
  } finally {
    f.cleanup();
  }
});

test("an explicit new send after reported failure cannot restart the previous item", async () => {
  const f = fixture();
  try {
    const d = f.store.submit(human, f.reviewId, f.input, m());
    await f.store.deliver(human, d.dispatchId, {
      async enqueue() {
        return { status: "accepted", rowId: 1 };
      },
    });
    const threadId = f.threads[0]!.threadId;
    f.store.updateWork(
      agent,
      d.dispatchId,
      threadId,
      { state: "failed", itemVersion: 1, threadVersion: 1, assignmentEpoch: 1 },
      m(),
    );
    const next = f.store.submit(
      human,
      f.reviewId,
      { target, items: [{ threadId, version: 1 }] },
      m(),
    );
    expect(next.dispatchId).not.toBe(d.dispatchId);
    expect(() =>
      f.store.updateWork(
        agent,
        d.dispatchId,
        threadId,
        {
          state: "in_progress",
          itemVersion: 2,
          threadVersion: 1,
          assignmentEpoch: 1,
        },
        m(),
      ),
    ).toThrow("Terminal");
  } finally {
    f.cleanup();
  }
});

test("CR-106/107/108 selection validation cannot partially dispatch or retarget", () => {
  const f = fixture();
  try {
    f.store.reply(human, f.threads[1]!.threadId, "changed", m(1));
    expect(() => f.store.submit(human, f.reviewId, f.input, m())).toThrow(
      "record changed",
    );
    expect(f.store.listDispatches(human)).toEqual([]);
    expect(() =>
      f.store.submit(
        human,
        f.reviewId,
        {
          ...f.input,
          items: [f.input.items[0]!, { threadId: "missing", version: 1 }],
        },
        m(),
      ),
    ).toThrow("unavailable");
    expect(() =>
      f.store.submit(
        human,
        f.reviewId,
        {
          ...f.input,
          target: { chatId: "web:other", incarnation: "b2", label: "Other" },
          items: [f.input.items[0]!],
        },
        m(),
      ),
    ).toThrow("reassign");
    expect(f.store.getThread(human, f.threads[0]!.threadId).target).toEqual(
      target,
    );
    expect(f.store.listDispatches(human)).toEqual([]);
  } finally {
    f.cleanup();
  }
});
test("CR-041/066/109 crash and uncertain failures stay unknown without replay", async () => {
  const f = fixture();
  try {
    const d = f.store.submit(human, f.reviewId, f.input, m());
    let calls = 0;
    await f.store.deliver(human, d.dispatchId, {
      async enqueue() {
        calls++;
        throw Error("token=do-not-store");
      },
    });
    expect(
      f.store.inspectDispatch(human, d.dispatchId).attempts[0],
    ).toMatchObject({ state: "unknown", error_code: "enqueue_failed" });
    expect(
      JSON.stringify(f.store.inspectDispatch(human, d.dispatchId)),
    ).not.toContain("do-not-store");
    expect(() => f.store.retry(human, d.dispatchId, m())).toThrow(
      "definitively rejected",
    );
    await f.store.deliver(human, d.dispatchId, {
      async enqueue() {
        calls++;
        return { status: "accepted", rowId: 5 };
      },
    });
    expect(calls).toBe(1);
    f.store.database.run(
      "UPDATE attempts SET state='attempting' WHERE id=?",
      d.attemptId,
    );
    const other = new ReviewService(f.path);
    try {
      expect(other.recoverInterrupted()).toBe(1);
      expect(
        other.inspectDispatch(human, d.dispatchId).attempts[0]?.state,
      ).toBe("unknown");
    } finally {
      other.close();
    }
  } finally {
    f.cleanup();
  }
});
test("CR-098 safe retry is numbered and unknown reconciliation is explicit", async () => {
  const f = fixture();
  try {
    const d = f.store.submit(human, f.reviewId, f.input, m());
    await f.store.deliver(human, d.dispatchId, {
      async enqueue() {
        throw Object.assign(Error("denied"), {
          delivery: "rejected",
          code: "target_unavailable",
        });
      },
    });
    const next = f.store.retry(human, d.dispatchId, m());
    expect(next.attemptId).not.toBe(d.attemptId);
    expect(
      f.store
        .inspectDispatch(human, d.dispatchId)
        .attempts.map((a) => a.number),
    ).toEqual([1, 2]);
    await f.store.deliver(human, d.dispatchId, {
      async enqueue() {
        throw Error("unknown");
      },
    });
    f.store.reconcile(
      human,
      d.dispatchId,
      {
        decision: "accepted",
        evidence: "Matched host receipt 42",
        hostRowId: 42,
        attemptId: next.attemptId,
      },
      m(),
    );
    expect(
      f.store.inspectDispatch(human, d.dispatchId).attempts[1],
    ).toMatchObject({ state: "accepted", host_row_id: 42 });
    expect(() => f.store.retry(human, d.dispatchId, m())).toThrow(
      "definitively rejected",
    );
  } finally {
    f.cleanup();
  }
});
test("CR-037 reply-and-send rolls back publication if batch validation fails", () => {
  const f = fixture();
  try {
    expect(() =>
      f.store.replyAndSubmit(
        human,
        f.threads[0]!.threadId,
        "reply",
        { ...target, incarnation: "other" },
        m(1),
      ),
    ).toThrow("reassign");
    expect(
      f.store.getThread(human, f.threads[0]!.threadId).messages,
    ).toHaveLength(1);
    const sent = f.store.replyAndSubmit(
      human,
      f.threads[0]!.threadId,
      "reply",
      target,
      m(1),
    );
    expect(
      f.store.getThread(human, f.threads[0]!.threadId).messages,
    ).toHaveLength(2);
    expect(f.store.inspectDispatch(human, sent.dispatchId).items).toHaveLength(
      1,
    );
  } finally {
    f.cleanup();
  }
});
test("agent may finish its item after its own evidence-backed resolution", async () => {
  const f = fixture();
  try {
    const d = f.store.submit(human, f.reviewId, f.input, m());
    await f.store.deliver(human, d.dispatchId, {
      async enqueue() {
        return { status: "accepted", rowId: 1 };
      },
    });
    const thread = f.threads[0]!.threadId;
    f.store.resolveThread(
      agent,
      thread,
      { explanation: "Verified", fileId: f.fileId, assignmentEpoch: 1 },
      m(1),
    );
    expect(
      f.store.updateWork(
        agent,
        d.dispatchId,
        thread,
        {
          state: "completed",
          itemVersion: 1,
          threadVersion: 2,
          assignmentEpoch: 1,
        },
        m(),
      ).state,
    ).toBe("completed");
  } finally {
    f.cleanup();
  }
});

test("CR-105/110/180 item work and resolution stay independent and stale items are superseded", async () => {
  const f = fixture();
  try {
    const d = f.store.submit(human, f.reviewId, f.input, m());
    await f.store.deliver(human, d.dispatchId, {
      async enqueue() {
        return { status: "accepted", rowId: 1 };
      },
    });
    const t1 = f.threads[0]!.threadId,
      t2 = f.threads[1]!.threadId;
    f.store.updateWork(
      agent,
      d.dispatchId,
      t1,
      {
        state: "completed",
        itemVersion: 1,
        threadVersion: 1,
        assignmentEpoch: 1,
      },
      m(),
    );
    expect(f.store.getThread(human, t1).state).toBe("open");
    f.store.resolveThread(
      agent,
      t1,
      { explanation: "Verified", fileId: f.fileId, assignmentEpoch: 1 },
      m(1),
    );
    expect(f.store.getThread(human, t2).state).toBe("open");
    f.store.deleteThread(human, t2, m(1));
    expect(() =>
      f.store.updateWork(
        agent,
        d.dispatchId,
        t2,
        {
          state: "in_progress",
          itemVersion: 1,
          threadVersion: 1,
          assignmentEpoch: 1,
        },
        m(),
      ),
    ).toThrow("superseded");
    f.store.updateWork(
      agent,
      d.dispatchId,
      t2,
      {
        state: "superseded",
        itemVersion: 1,
        threadVersion: 1,
        assignmentEpoch: 1,
      },
      m(),
    );
    expect(f.store.inspectDispatch(agent, d.dispatchId).items[1]).toMatchObject(
      { unavailable: true, work_state: "superseded" },
    );
    expect(() => f.store.getThread(agent, t2)).toThrow("unavailable");
    expect(() =>
      f.store.updateWork(
        agent,
        d.dispatchId,
        t1,
        {
          state: "in_progress",
          itemVersion: 2,
          threadVersion: 2,
          assignmentEpoch: 1,
        },
        m(),
      ),
    ).toThrow();
  } finally {
    f.cleanup();
  }
});
