import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "./dispatch.js";
import type {
  LocalTarget,
  ReviewIdentity,
  SourceCapture,
} from "./contracts.js";

let fixtureSerial = 0;

function copySqliteStore(from: string, to: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${from}${suffix}`;
    if (existsSync(source)) copyFileSync(source, `${to}${suffix}`);
  }
}

function createFixture() {
  const serial = ++fixtureSerial;
  const workspaceId = `workspace-${serial}`;
  const worktreeId = `worktree-${serial}`;
  const dir = mkdtempSync(join(tmpdir(), `code-review-durability-${serial}-`));
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
    incarnation: `chat-${serial}`,
    label: "Worker",
  };
  const agent: ReviewIdentity = {
    ownerId: operator.ownerId,
    actorId: `agent:${serial}`,
    kind: "agent",
    chatId: target.chatId,
    chatIncarnation: target.incarnation,
  };
  const otherOwner: ReviewIdentity = {
    ownerId: `other-owner:${serial}`,
    actorId: `other-operator:${serial}`,
    kind: "operator",
    workspaceId,
  };

  const mutation = (expectedVersion?: number, requestId?: string) => ({
    requestId: requestId ?? `req-${serial}-${++request}`,
    expectedVersion,
  });

  const capture = (
    text = "alpha\nbeta\ngamma\n",
    fileIdentity = `inode:${serial}`,
  ): SourceCapture => ({
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
        fileIdentity,
      },
    ],
  });

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
    otherOwner,
    mutation,
    capture,
    store: () => store,
    createReview(title = "Durability review") {
      return store.createReview(
        operator,
        {
          workspaceId,
          worktreeId,
          title,
          focusPath: "src/main.ts",
          target,
        },
        mutation(),
      ).reviewId;
    },
    createCapture(reviewId: string, text?: string, fileIdentity?: string) {
      return store.capture(operator, reviewId, capture(text, fileIdentity), mutation())
        .files[0]!;
    },
    reopen() {
      close();
      store = new ReviewService(path);
      closed = false;
      return store;
    },
    close,
    cleanup() {
      close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("CR-065 file-backed reopen restores committed messages, thread state and immutable source", () => {
  const f = createFixture();
  try {
    const reviewId = f.createReview();
    const fileId = f.createCapture(reviewId, "alpha\nbeta\ngamma\n", "inode:cr-065");
    const created = f.store().createThread(
      f.operator,
      reviewId,
      {
        fileId,
        side: "source",
        range: { startLine: 2, endLine: 2 },
        body: "Original guidance",
      },
      f.mutation(),
    );
    f.store().reply(
      f.agent,
      created.threadId,
      "Agent acknowledgement",
      f.mutation(1),
      1,
    );
    f.store().editMessage(
      f.operator,
      created.messageId,
      "Edited guidance",
      f.mutation(1),
    );
    f.store().resolveThread(
      f.operator,
      created.threadId,
      {
        explanation: "Resolved with persisted evidence",
        evidence: ["src/main.ts#L2"],
        fileId,
      },
      f.mutation(3),
    );

    const reopened = f.reopen();
    const thread = reopened.getThread(f.operator, created.threadId);
    const source = reopened.readFile(f.operator, reviewId, fileId);

    expect(thread.state).toBe("resolved");
    expect(thread.anchor.selectedText).toBe("beta");
    expect(thread.source.fileId).toBe(fileId);
    expect(thread.messages.map((message) => message.body)).toEqual([
      "Edited guidance",
      "Agent acknowledgement",
      "Resolved with persisted evidence",
    ]);
    expect(thread.messages.map((message) => message.author_id)).toEqual([
      f.operator.actorId,
      f.agent.actorId,
      f.operator.actorId,
    ]);
    expect(thread.messages.map((message) => message.ordinal)).toEqual([1, 2, 3]);
    expect(source.newText).toBe("alpha\nbeta\ngamma\n");
    expect(source.new_path).toBe("src/main.ts");
    expect(source.file_identity).toBe("inode:cr-065");
  } finally {
    f.cleanup();
  }
});

test("CR-066 process restart preserves open and resolved threads and exposes interrupted delivery as unknown without replay", () => {
  const f = createFixture();
  try {
    const reviewId = f.createReview();
    const fileId = f.createCapture(reviewId, "one\ntwo\nthree\n", "inode:cr-066");
    const openThread = f.store().createThread(
      f.operator,
      reviewId,
      { fileId, side: "source", body: "Open concern" },
      f.mutation(),
    );
    const resolvedThread = f.store().createThread(
      f.operator,
      reviewId,
      {
        fileId,
        side: "source",
        range: { startLine: 2, endLine: 2 },
        body: "Resolved concern",
      },
      f.mutation(),
    );
    f.store().resolveThread(
      f.operator,
      resolvedThread.threadId,
      { explanation: "Done", fileId },
      f.mutation(1),
    );
    const dispatch = f.store().submit(
      f.operator,
      reviewId,
      {
        target: f.target,
        items: [{ threadId: openThread.threadId, version: 1 }],
      },
      f.mutation(),
    );
    f.store().database.run(
      "UPDATE attempts SET state='attempting' WHERE id=?",
      dispatch.attemptId,
    );

    const reopened = f.reopen();
    expect(reopened.recoverInterrupted()).toBe(1);

    expect(reopened.getThread(f.operator, openThread.threadId).state).toBe("open");
    expect(reopened.getThread(f.operator, resolvedThread.threadId).state).toBe(
      "resolved",
    );

    const recovered = reopened.inspectDispatch(f.operator, dispatch.dispatchId);
    expect(recovered.attempts).toHaveLength(1);
    expect(recovered.attempts[0]).toMatchObject({
      id: dispatch.attemptId,
      state: "unknown",
      error_code: "interrupted",
    });
    expect(
      reopened.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM attempts WHERE dispatch_id=?",
        dispatch.dispatchId,
      )?.n,
    ).toBe(1);
    expect(
      reopened.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM events WHERE dispatch_id=? AND kind='dispatch.retry'",
        dispatch.dispatchId,
      )?.n,
    ).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("CR-068 failed comment writes roll back cleanly, retain the saved draft and succeed once storage recovers", () => {
  const f = createFixture();
  try {
    const reviewId = f.createReview();
    const fileId = f.createCapture(reviewId, "draft\nreply\nsource\n", "inode:cr-068");
    const thread = f.store().createThread(
      f.operator,
      reviewId,
      { fileId, side: "source", body: "Root" },
      f.mutation(),
    );
    const draft = f.store().saveDraft(
      f.operator,
      reviewId,
      { threadId: thread.threadId, body: "Persist this draft" },
      f.mutation(),
    );
    const requestId = "cr-068-post";
    const beforeEvents = f.store().events(f.operator, reviewId).length;

    f.store().database.run(
      "CREATE TRIGGER fail_comment BEFORE INSERT ON message_revisions WHEN NEW.body='Persist this draft' BEGIN SELECT RAISE(ABORT,'injected write failure'); END",
    );

    expect(() =>
      f.store().reply(f.operator, thread.threadId, "Persist this draft", {
        requestId,
        expectedVersion: 1,
      }),
    ).toThrow("injected write failure");

    const drafts = f.store().listDrafts(f.operator, reviewId) as Array<{
      id: string;
      body: string;
      version: number;
    }>;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.id).toBe(draft.draftId);
    expect(drafts[0]?.body).toBe("Persist this draft");
    expect(drafts[0]?.version).toBe(1);
    expect(f.store().getThread(f.operator, thread.threadId).version).toBe(1);
    expect(f.store().getThread(f.operator, thread.threadId).messages).toHaveLength(1);
    expect(f.store().listDispatches(f.operator)).toEqual([]);
    expect(
      f.store().database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM request_receipts WHERE request_id=?",
        requestId,
      )?.n ?? 0,
    ).toBe(0);
    expect(f.store().events(f.operator, reviewId).length).toBe(beforeEvents);

    f.store().database.run("DROP TRIGGER fail_comment");

    const posted = f.store().reply(f.operator, thread.threadId, "Persist this draft", {
      requestId,
      expectedVersion: 1,
    });
    expect(posted.version).toBe(2);
    expect(
      f.store().getThread(f.operator, thread.threadId).messages.at(-1)?.body,
    ).toBe("Persist this draft");
  } finally {
    f.cleanup();
  }
});

test("CR-177 repeated authorised deletes replay the same receipt, preserve tombstones and never expose deleted content", () => {
  const f = createFixture();
  try {
    const reviewId = f.createReview();
    const fileId = f.createCapture(reviewId, "keep\nthread\nstate\n", "inode:cr-177");
    const created = f.store().createThread(
      f.operator,
      reviewId,
      { fileId, side: "source", body: "Delete this body" },
      f.mutation(),
    );
    f.store().reply(
      f.agent,
      created.threadId,
      "Agent reply survives",
      f.mutation(1),
      1,
    );

    const deleteReceipt = f.store().editMessage(
      f.operator,
      created.messageId,
      null,
      { requestId: "K1", expectedVersion: 1 },
    );

    expect(
      f.store().editMessage(f.operator, created.messageId, null, {
        requestId: "K1",
        expectedVersion: 1,
      }),
    ).toEqual(deleteReceipt);

    const thread = f.store().getThread(f.operator, created.threadId);
    expect(thread.messages.map((message) => message.id)).toEqual([
      created.messageId,
      thread.messages[1]!.id,
    ]);
    expect(thread.messages[0]).toMatchObject({ body: null, deleted: 1, ordinal: 1 });
    expect(thread.messages[1]).toMatchObject({
      body: "Agent reply survives",
      deleted: 0,
      author_id: f.agent.actorId,
      ordinal: 2,
    });
    expect(
      f.store().database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM message_revisions WHERE message_id=?",
        created.messageId,
      )?.n,
    ).toBe(2);
    expect(
      JSON.stringify(
        f.store().database.all(
          "SELECT result_json FROM request_receipts WHERE owner_id=? AND actor_id=? AND request_id='K1'",
          f.operator.ownerId,
          f.operator.actorId,
        ),
      ),
    ).not.toContain("Delete this body");
    expect(JSON.stringify(f.store().getThread(f.agent, created.threadId))).not.toContain(
      "Delete this body",
    );
    expect(() =>
      f.store().editMessage(f.operator, created.messageId, "resurrected", {
        requestId: "K1",
        expectedVersion: 1,
      }),
    ).toThrow("different action or payload");
    expect(() =>
      f.store().editMessage(f.otherOwner, created.messageId, null, {
        requestId: "K1",
        expectedVersion: 1,
      }),
    ).toThrow("unavailable");
  } finally {
    f.cleanup();
  }
});

test("CR-181 newer unsupported schema opens fail explicitly and leave the SQLite file untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "code-review-unsupported-schema-"));
  const path = join(dir, "reviews.db");
  try {
    const raw = new Database(path);
    raw.exec(
      "CREATE TABLE sentinel(value TEXT NOT NULL); INSERT INTO sentinel VALUES('keep-me'); PRAGMA user_version=2;",
    );
    raw.close();

    expect(() => new ReviewService(path)).toThrow("newer add-on");

    const reopened = new Database(path);
    try {
      expect(
        (reopened.query("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ).toBe(2);
      expect(
        reopened.query("SELECT value FROM sentinel").get() as { value: string },
      ).toEqual({ value: "keep-me" });
      expect(
        reopened
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as Array<{ name: string }>,
      ).toEqual([{ name: "sentinel" }]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CR-182 copied SQLite backups restore reviews, drafts, resolutions and delivery receipts while revalidating workspace and agent access", async () => {
  const f = createFixture();
  const backupDir = mkdtempSync(join(tmpdir(), "code-review-backup-"));
  const restoreDir = mkdtempSync(join(tmpdir(), "code-review-restore-"));
  const backupPath = join(backupDir, "reviews.db");
  const restorePath = join(restoreDir, "reviews.db");
  try {
    const reviewId = f.createReview();
    const fileId = f.createCapture(
      reviewId,
      "restore\nthis\nsource\n",
      "inode:cr-182",
    );
    const openThread = f.store().createThread(
      f.operator,
      reviewId,
      { fileId, side: "source", body: "Open discussion" },
      f.mutation(),
    );
    const resolvedThread = f.store().createThread(
      f.operator,
      reviewId,
      {
        fileId,
        side: "source",
        range: { startLine: 2, endLine: 2 },
        body: "Needs proof",
      },
      f.mutation(),
    );
    f.store().resolveThread(
      f.operator,
      resolvedThread.threadId,
      { explanation: "Verified", fileId },
      f.mutation(1),
    );
    const draft = f.store().saveDraft(
      f.operator,
      reviewId,
      { threadId: openThread.threadId, body: "Private draft" },
      f.mutation(),
    );
    const dispatch = f.store().submit(
      f.operator,
      reviewId,
      {
        target: f.target,
        items: [{ threadId: openThread.threadId, version: 1 }],
      },
      f.mutation(),
    );
    await f.store().deliver(f.operator, dispatch.dispatchId, {
      async enqueue() {
        throw Error("temporary host outage");
      },
    });

    f.close();
    copySqliteStore(f.path, backupPath);
    copySqliteStore(backupPath, restorePath);

    const restored = new ReviewService(restorePath);
    try {
      const restoredDrafts = restored.listDrafts(f.operator, reviewId) as Array<{
        id: string;
        body: string;
      }>;
      expect(restored.getReview(f.operator, reviewId).workspace_id).toBe(
        f.operator.workspaceId!,
      );
      expect(restored.readFile(f.operator, reviewId, fileId)).toMatchObject({
        newText: "restore\nthis\nsource\n",
        file_identity: "inode:cr-182",
      });
      expect(restored.getThread(f.operator, resolvedThread.threadId).state).toBe(
        "resolved",
      );
      expect(restored.getThread(f.operator, openThread.threadId).state).toBe("open");
      expect(restoredDrafts).toHaveLength(1);
      expect(restoredDrafts[0]?.id).toBe(draft.draftId);
      expect(restoredDrafts[0]?.body).toBe("Private draft");
      expect(
        JSON.stringify(restored.getThread(f.agent, openThread.threadId)),
      ).not.toContain("Private draft");
      expect(() => restored.listDrafts(f.agent, reviewId)).toThrow(
        "Operator action",
      );

      const receipt = restored.inspectDispatch(f.operator, dispatch.dispatchId);
      expect(receipt.attempts).toHaveLength(1);
      expect(receipt.attempts[0]).toMatchObject({
        state: "unknown",
        error_code: "enqueue_failed",
      });
      expect(restored.inspectDispatch(f.agent, dispatch.dispatchId).attempts[0]?.state).toBe(
        "unknown",
      );
      expect(
        restored.database.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM attempts WHERE dispatch_id=?",
          dispatch.dispatchId,
        )?.n,
      ).toBe(1);

      const wrongWorkspace: ReviewIdentity = {
        ...f.operator,
        workspaceId: `${f.operator.workspaceId}-other`,
      };
      const wrongAgent: ReviewIdentity = {
        ...f.agent,
        chatIncarnation: `${f.agent.chatIncarnation}-reused`,
      };

      expect(() => restored.getReview(wrongWorkspace, reviewId)).toThrow(
        "unavailable",
      );
      expect(() => restored.getThread(wrongWorkspace, openThread.threadId)).toThrow(
        "unavailable",
      );
      expect(() => restored.inspectDispatch(wrongAgent, dispatch.dispatchId)).toThrow(
        "unavailable",
      );
    } finally {
      restored.close();
    }
  } finally {
    f.cleanup();
    rmSync(backupDir, { recursive: true, force: true });
    rmSync(restoreDir, { recursive: true, force: true });
  }
});
