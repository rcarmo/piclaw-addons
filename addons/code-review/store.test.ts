import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { ReviewStore } from "./store.js";
import { createAnchor } from "./anchors.js";
import { hashText } from "./validation.js";
import type {
  ReviewIdentity,
  LocalTarget,
  SourceCapture,
} from "./contracts.js";
const human: ReviewIdentity = {
  ownerId: "operator:one",
  actorId: "human:one",
  kind: "operator",
};
const other: ReviewIdentity = {
  ownerId: "operator:two",
  actorId: "human:two",
  kind: "operator",
};
const target: LocalTarget = {
  chatId: "web:implementation",
  incarnation: "chat-1",
  label: "Implementation",
};
const agent: ReviewIdentity = {
  ownerId: human.ownerId,
  actorId: "agent:implementation",
  kind: "agent",
  chatId: target.chatId,
  chatIncarnation: target.incarnation,
};
let seq = 0;
const m = (expectedVersion?: number) => ({
  requestId: `req-${++seq}`,
  expectedVersion,
});
function capture(text = "one\ntwo\nthree\n"): SourceCapture {
  return {
    workspaceId: "workspace-1",
    worktreeId: "worktree-1",
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
        fileIdentity: "device:inode:birth",
      },
    ],
  };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-store-"));
  const path = join(dir, "reviews.db");
  const store = new ReviewStore(path);
  const reviewId = store.createReview(
    human,
    {
      workspaceId: "workspace-1",
      worktreeId: "worktree-1",
      title: "Review",
      focusPath: "src/main.ts",
      target,
    },
    m(),
  ).reviewId;
  const fileId = store.capture(human, reviewId, capture(), m()).files[0]!;
  const thread = store.createThread(
    human,
    reviewId,
    {
      fileId,
      side: "source",
      range: { startLine: 2, endLine: 2 },
      body: "Keep validation",
    },
    m(),
  );
  return {
    store,
    path,
    dir,
    reviewId,
    fileId,
    thread,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("CR-167/169/170 store persists exact snapshots and deduplicates bytes per review", () => {
  const f = fixture();
  try {
    expect(f.store.readFile(human, f.reviewId, f.fileId).newText).toBe(
      "one\ntwo\nthree\n",
    );
    const second = f.store.capture(human, f.reviewId, capture(), m());
    expect(second.files[0]).not.toBe(f.fileId);
    expect(
      f.store.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs")?.n,
    ).toBe(1);
    f.store.capture(human, f.reviewId, capture("one\r\ntwo\r\nthree\r\n"), m());
    expect(
      f.store.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs")?.n,
    ).toBe(2);
    const reopened = new ReviewStore(f.path);
    try {
      expect(
        reopened.getThread(human, f.thread.threadId).messages[0]?.body,
      ).toBe("Keep validation");
    } finally {
      reopened.close();
    }
  } finally {
    f.cleanup();
  }
});
test("CR-022/024/028/172 versions conflict and deleting bodies purges revisions but retains replies", () => {
  const f = fixture();
  try {
    const reply = f.store.reply(
      agent,
      f.thread.threadId,
      "Acknowledged",
      m(1),
      1,
    );
    expect(reply.version).toBe(2);
    expect(() =>
      f.store.editMessage(human, f.thread.messageId, "stale", m(0)),
    ).toThrow("record changed");
    const edit = f.store.editMessage(
      human,
      f.thread.messageId,
      "New guidance",
      m(1),
    );
    expect(edit.version).toBe(2);
    expect(f.store.getThread(agent, f.thread.threadId).messages[0]?.body).toBe(
      "New guidance",
    );
    f.store.editMessage(human, f.thread.messageId, null, m(2));
    const messages = f.store.getThread(human, f.thread.threadId).messages;
    expect(messages.map((r) => r.body)).toEqual([null, "Acknowledged"]);
    expect(
      f.store.database
        .all<{
          body: null;
        }>(
          "SELECT body FROM message_revisions WHERE message_id=?",
          f.thread.messageId,
        )
        .every((r) => r.body === null),
    ).toBe(true);
    expect(messages[0]?.id).toBe(f.thread.messageId);
  } finally {
    f.cleanup();
  }
});
test("CR-079/078/029 agent and foreign owner cannot read unrelated records or impersonate authors", () => {
  const f = fixture();
  try {
    expect(() => f.store.getThread(other, f.thread.threadId)).toThrow(
      "unavailable",
    );
    expect(() =>
      f.store.getThread(
        { ...agent, chatIncarnation: "reused" },
        f.thread.threadId,
      ),
    ).toThrow("unavailable");
    expect(() =>
      f.store.editMessage(agent, f.thread.messageId, "override", m(1), 1),
    ).toThrow("Only the message author");
    expect(() =>
      f.store.createReview(
        agent,
        {
          workspaceId: "workspace-1",
          worktreeId: "worktree-1",
          title: "x",
          focusPath: "x",
          target,
        },
        m(),
      ),
    ).toThrow("Operator action");
    expect(f.store.listThreads(agent, f.reviewId).length).toBe(1);
  } finally {
    f.cleanup();
  }
});
test("CR-046/047/050/052/179 resolve requires explanation/current version and reopening retains evidence", () => {
  const f = fixture();
  try {
    expect(() =>
      f.store.resolveThread(
        agent,
        f.thread.threadId,
        { explanation: "", fileId: f.fileId, assignmentEpoch: 1 },
        m(1),
      ),
    ).toThrow("non-empty");
    f.store.reply(human, f.thread.threadId, "new requirement", m(1));
    expect(() =>
      f.store.resolveThread(
        agent,
        f.thread.threadId,
        { explanation: "done", fileId: f.fileId, assignmentEpoch: 1 },
        m(1),
      ),
    ).toThrow("record changed");
    f.store.resolveThread(
      agent,
      f.thread.threadId,
      {
        explanation: "No change needed; validation already precedes I/O",
        evidence: ["src/main.ts#L2"],
        fileId: f.fileId,
        assignmentEpoch: 1,
      },
      m(2),
    );
    expect(f.store.getThread(human, f.thread.threadId).state).toBe("resolved");
    expect(() =>
      f.store.reply(agent, f.thread.threadId, "late", m(3), 1),
    ).toThrow("reopen-and-post");
    f.store.reply(
      human,
      f.thread.threadId,
      "Still fails",
      m(3),
      undefined,
      true,
    );
    expect(f.store.getThread(human, f.thread.threadId).state).toBe("open");
    const events = f.store.events(human, f.reviewId) as {
      kind: string;
      data_json: string;
    }[];
    expect(
      events.some(
        (e) =>
          e.kind === "thread.resolved" &&
          JSON.parse(e.data_json).fileId === f.fileId,
      ),
    ).toBe(true);
    expect(events.some((e) => e.kind === "thread.reopened")).toBe(true);
  } finally {
    f.cleanup();
  }
});
test("CR-099/100/178 changing default does not retarget threads and reassignment rejects old agent", () => {
  const f = fixture();
  try {
    const next = {
      chatId: "web:reviewer",
      incarnation: "chat-2",
      label: "Reviewer",
    };
    f.store.setTarget(human, f.reviewId, next, m(1));
    expect(f.store.getThread(agent, f.thread.threadId).target).toEqual(target);
    const second = f.store.createThread(
      human,
      f.reviewId,
      { fileId: f.fileId, side: "source", body: "new" },
      m(),
    );
    expect(f.store.getThread(human, second.threadId).target).toEqual(next);
    f.store.reassign(human, f.thread.threadId, next, m(1));
    expect(() =>
      f.store.reply(agent, f.thread.threadId, "late", m(2), 1),
    ).toThrow("unavailable");
    const replacement = {
      ...agent,
      chatId: next.chatId,
      chatIncarnation: next.incarnation,
    };
    expect(() =>
      f.store.reply(replacement, f.thread.threadId, "old epoch", m(2), 1),
    ).toThrow("assignment changed");
    expect(
      f.store.reply(replacement, f.thread.threadId, "current", m(2), 2).version,
    ).toBe(3);
  } finally {
    f.cleanup();
  }
});
test("CR-020/031/070/177 retries return IDs only and never resurrect deleted text", () => {
  const f = fixture();
  try {
    const req = m(),
      input = {
        fileId: f.fileId,
        side: "source" as const,
        body: "secret guidance",
      };
    const created = f.store.createThread(human, f.reviewId, input, req);
    expect(f.store.createThread(human, f.reviewId, input, req)).toEqual(
      created,
    );
    expect(() =>
      f.store.createThread(human, f.reviewId, { ...input, body: "other" }, req),
    ).toThrow("different action or payload");
    f.store.deleteThread(human, created.threadId, m(1));
    expect(f.store.createThread(human, f.reviewId, input, req)).toEqual(
      created,
    );
    expect(() => f.store.getThread(human, created.threadId)).toThrow(
      "unavailable",
    );
    expect(
      JSON.stringify(
        f.store.database.all("SELECT result_json FROM request_receipts"),
      ),
    ).not.toContain("secret guidance");
    expect(f.store.listThreads(human, f.reviewId)).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
test("CR-093/094/174 private drafts survive reopen and cannot be read by agents", () => {
  const f = fixture();
  try {
    const draft = f.store.saveDraft(
      human,
      f.reviewId,
      { threadId: f.thread.threadId, body: "Unpublished" },
      m(),
    );
    const second = new ReviewStore(f.path);
    try {
      expect(second.listDrafts(human, f.reviewId)).toHaveLength(1);
    } finally {
      second.close();
    }
    expect(() => f.store.listDrafts(agent, f.reviewId)).toThrow(
      "Operator action",
    );
    expect(
      JSON.stringify(f.store.getThread(agent, f.thread.threadId)),
    ).not.toContain("Unpublished");
    expect(() =>
      f.store.saveDraft(
        human,
        f.reviewId,
        { id: draft.draftId, threadId: f.thread.threadId, body: "conflict" },
        m(0),
      ),
    ).toThrow("record changed");
    f.store.saveDraft(
      human,
      f.reviewId,
      { id: draft.draftId, threadId: f.thread.threadId, body: "Changed" },
      m(1),
    );
    f.store.deleteThread(human, f.thread.threadId, m(1));
    expect(f.store.listDrafts(human, f.reviewId)).toEqual([]);
  } finally {
    f.cleanup();
  }
});
test("CR-183 cross-review anchors and draft references reject atomically", () => {
  const f = fixture();
  try {
    const another = f.store.createReview(
      human,
      {
        workspaceId: "workspace-1",
        worktreeId: "worktree-1",
        title: "Other",
        focusPath: "src/main.ts",
        target,
      },
      m(),
    );
    const before = f.store.database.get<{ n: number }>(
      "SELECT COUNT(*) n FROM request_receipts",
    )!.n;
    expect(() =>
      f.store.createThread(
        human,
        another.reviewId,
        { fileId: f.fileId, side: "source", body: "cross" },
        m(),
      ),
    ).toThrow("unavailable");
    expect(() =>
      f.store.saveDraft(
        human,
        another.reviewId,
        { threadId: f.thread.threadId, body: "cross" },
        m(),
      ),
    ).toThrow("unavailable");
    expect(
      f.store.database.get<{ n: number }>(
        "SELECT COUNT(*) n FROM request_receipts",
      )!.n,
    ).toBe(before);
    const anchor = createAnchor(f.fileId, "source", "one\ntwo\nthree\n", {
      startLine: 2,
      endLine: 2,
    });
    expect(() =>
      f.store.saveDraft(
        human,
        f.reviewId,
        { anchor: { ...anchor, blobSha256: hashText("wrong") }, body: "bad" },
        m(),
      ),
    ).toThrow("must match source");
  } finally {
    f.cleanup();
  }
});
test("CR-055/058/060/103 projection rejects recreated files and manual re-anchor preserves original", () => {
  const f = fixture();
  try {
    const original = f.store.getThread(human, f.thread.threadId).anchor;
    const shifted = f.store.capture(
      human,
      f.reviewId,
      capture("prefix\none\ntwo\nthree\n"),
      m(),
    ).files[0]!;
    expect(f.store.project(human, f.thread.threadId, shifted)).toMatchObject({
      status: "moved",
      startLine: 3,
    });
    const recreated = capture();
    recreated.files[0]!.fileIdentity = "another-inode";
    const other = f.store.capture(human, f.reviewId, recreated, m()).files[0]!;
    expect(f.store.project(human, f.thread.threadId, other).status).toBe(
      "missing",
    );
    expect(() =>
      f.store.resolveThread(
        agent,
        f.thread.threadId,
        { explanation: "wrong file", fileId: other, assignmentEpoch: 1 },
        m(1),
      ),
    ).toThrow("verified source mapping");
    f.store.resolveThread(
      human,
      f.thread.threadId,
      { explanation: "handled", fileId: f.fileId },
      m(1),
    );
    expect(() =>
      f.store.reanchor(
        human,
        f.thread.threadId,
        { fileId: other, side: "source", range: { startLine: 1, endLine: 1 } },
        m(2),
      ),
    ).toThrow("reopen-and-re-anchor");
    f.store.reanchor(
      human,
      f.thread.threadId,
      {
        fileId: other,
        side: "source",
        range: { startLine: 1, endLine: 1 },
        reopen: true,
      },
      m(2),
    );
    expect(f.store.getThread(human, f.thread.threadId)).toMatchObject({
      state: "open",
      anchor: original,
    });
    expect(f.store.project(human, f.thread.threadId, other)).toMatchObject({
      method: "manual",
      startLine: 1,
    });
  } finally {
    f.cleanup();
  }
});

test("CR-010/126 empty diffs persist and adding saved files keeps earlier snapshot membership", () => {
  const f = fixture();
  try {
    const empty = { ...capture(), mode: "unstaged" as const, files: [] };
    expect(f.store.capture(human, f.reviewId, empty, m()).files).toEqual([]);
    const snapshot = f.store.database.get<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM snapshot_files WHERE id=?",
      f.fileId,
    )!;
    const next = capture("second file\n");
    next.files[0]!.newPath = "src/other.ts";
    const added = f.store.addFile(
      human,
      f.reviewId,
      snapshot.snapshot_id,
      next,
      m(),
    );
    expect(added.files).toHaveLength(2);
    expect(
      f.store.snapshotFiles(human, f.reviewId, snapshot.snapshot_id),
    ).toHaveLength(1);
    expect(
      f.store
        .snapshotFiles(human, f.reviewId, added.snapshotId)
        .map((file) => file.new_path),
    ).toEqual(["src/main.ts", "src/other.ts"]);
    expect(
      f.store.getThread(human, f.thread.threadId).anchor.snapshotFileId,
    ).toBe(f.fileId);
  } finally {
    f.cleanup();
  }
});

test("CR-182 restored store requires the original trusted workspace identity", () => {
  const f = fixture();
  try {
    const replaced = { ...human, workspaceId: "different-workspace" };
    expect(() => f.store.getReview(replaced, f.reviewId)).toThrow(
      "unavailable",
    );
    expect(() => f.store.getThread(replaced, f.thread.threadId)).toThrow(
      "unavailable",
    );
    expect(f.store.listReviews(replaced)).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("CR-181 newer or unversioned nonempty DBs are rejected without reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-schema-"));
  try {
    const path = join(dir, "future.db"),
      db = new Database(path);
    db.exec(
      "CREATE TABLE valuable(value TEXT); INSERT INTO valuable VALUES('retained'); PRAGMA user_version=999",
    );
    db.close();
    expect(() => new ReviewStore(path)).toThrow("newer add-on");
    const reopened = new Database(path);
    expect(reopened.query("SELECT value FROM valuable").get()).toEqual({
      value: "retained",
    });
    reopened.exec("PRAGMA user_version=0");
    reopened.close();
    expect(() => new ReviewStore(path)).toThrow("Unversioned non-empty");
    const link = join(dir, "linked.db");
    symlinkSync(path, link);
    expect(() => new ReviewStore(link)).toThrow("regular file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
