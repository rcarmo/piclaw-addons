import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "./dispatch.js";
import type {
  ReviewIdentity,
  LocalTarget,
  SourceCapture,
} from "./contracts.js";
const who: ReviewIdentity = {
  ownerId: "owner",
  actorId: "human",
  kind: "operator",
  workspaceId: "workspace",
};
const target: LocalTarget = {
  chatId: "web:worker",
  incarnation: "branch",
  label: "Worker",
};
const agent: ReviewIdentity = {
  ...who,
  actorId: "branch",
  kind: "agent",
  chatId: target.chatId,
  chatIncarnation: target.incarnation,
};
let n = 0;
const m = (expectedVersion?: number) => ({
  requestId: `key-${++n}`,
  expectedVersion,
});
function f() {
  const dir = mkdtempSync(join(tmpdir(), "review-security-"));
  const s = new ReviewService(join(dir, "db"));
  const r = s.createReview(
    who,
    {
      workspaceId: "workspace",
      worktreeId: "tree",
      title: "R",
      focusPath: "a.ts",
      target,
    },
    m(),
  );
  const cap: SourceCapture = {
    workspaceId: "workspace",
    worktreeId: "tree",
    mode: "source",
    base: null,
    head: null,
    capturedAt: "2026-01-01",
    files: [
      {
        oldPath: null,
        newPath: "a.ts",
        oldText: null,
        newText: "a\nb\nc\n",
        change: "source",
        fileIdentity: "inode",
      },
    ],
  };
  const snap = s.capture(who, r.reviewId, cap, m());
  const t = s.createThread(
    who,
    r.reviewId,
    { fileId: snap.files[0]!, side: "source", body: "root" },
    m(),
  );
  return {
    dir,
    s,
    r,
    snap,
    t,
    close() {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("CR-025/029/032/095/096/173 all message revisions are purged on author deletion and late replies fail closed", () => {
  const x = f();
  try {
    const a = x.s.reply(agent, x.t.threadId, "agent secret", m(1), 1);
    x.s.editMessage(agent, a.messageId, "agent corrected secret", m(1), 1);
    expect(() => x.s.editMessage(who, a.messageId, "forged", m(2))).toThrow(
      "author",
    );
    x.s.editMessage(agent, a.messageId, null, m(2), 1);
    expect(x.s.getThread(who, x.t.threadId).messages.at(-1)).toMatchObject({
      body: null,
      deleted: 1,
    });
    expect(
      JSON.stringify(
        x.s.database.all(
          "SELECT body FROM message_revisions WHERE message_id=?",
          a.messageId,
        ),
      ),
    ).not.toContain("secret");
    const current = x.s.getThread(who, x.t.threadId);
    x.s.deleteThread(who, x.t.threadId, m(current.version));
    expect(() =>
      x.s.reply(agent, x.t.threadId, "late", m(current.version + 1), 1),
    ).toThrow("unavailable");
    expect(x.s.listThreads(who, x.r.reviewId)).toEqual([]);
  } finally {
    x.close();
  }
});
test("CR-069/071/072 stale concurrent mutations yield one serial result and message ordinals remain stable", () => {
  const x = f();
  try {
    const request = m(1);
    const first = x.s.reply(who, x.t.threadId, "first", request);
    expect(x.s.reply(who, x.t.threadId, "first", request)).toEqual(first);
    expect(() => x.s.reply(agent, x.t.threadId, "racing", m(1), 1)).toThrow(
      "record changed",
    );
    expect(() => x.s.deleteThread(who, x.t.threadId, m(1))).toThrow(
      "record changed",
    );
    x.s.reply(agent, x.t.threadId, "second", m(2), 1);
    expect(
      x.s.getThread(who, x.t.threadId).messages.map((a) => a.ordinal),
    ).toEqual([1, 2, 3]);
  } finally {
    x.close();
  }
});
test("CR-074 bounded pages never return another thread or silently accept negative cursors", () => {
  const x = f();
  try {
    for (let i = 0; i < 8; i++)
      x.s.reply(who, x.t.threadId, "reply " + i, m(i + 1));
    expect(
      x.s.getThread(who, x.t.threadId, 0, 3).messages.map((a) => a.ordinal),
    ).toEqual([1, 2, 3]);
    expect(
      x.s.getThread(who, x.t.threadId, 3, 3).messages.map((a) => a.ordinal),
    ).toEqual([4, 5, 6]);
    expect(() => x.s.getThread(who, x.t.threadId, -1, 3)).toThrow("cursor");
    expect(() => x.s.getThread(who, x.t.threadId, 0, 101)).toThrow("Page size");
    const alien = { ...who, ownerId: "someone-else" };
    expect(() => x.s.getThread(alien, x.t.threadId, 3, 3)).toThrow(
      "unavailable",
    );
  } finally {
    x.close();
  }
});
test("CR-068/172/174 failed multi-record writes roll back and private drafts reject reply-target mutation", () => {
  const x = f();
  try {
    const draft = x.s.saveDraft(
      who,
      x.r.reviewId,
      { threadId: x.t.threadId, body: "private" },
      m(),
    );
    const t2 = x.s.createThread(
      who,
      x.r.reviewId,
      { fileId: x.snap.files[0]!, side: "source", body: "other" },
      m(),
    );
    expect(() =>
      x.s.saveDraft(
        who,
        x.r.reviewId,
        { id: draft.draftId, threadId: t2.threadId, body: "retarget" },
        m(1),
      ),
    ).toThrow("cannot silently change");
    expect(JSON.stringify(x.s.listDrafts(who, x.r.reviewId))).toContain(
      "private",
    );
    x.s.database.run(
      "CREATE TRIGGER fail_reply BEFORE INSERT ON message_revisions WHEN NEW.body='blocked' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END",
    );
    expect(() => x.s.reply(who, x.t.threadId, "blocked", m(1))).toThrow(
      "injected",
    );
    expect(x.s.getThread(who, x.t.threadId).messages).toHaveLength(1);
    expect(x.s.getThread(who, x.t.threadId).version).toBe(1);
    x.s.database.run("DROP TRIGGER fail_reply");
    expect(x.s.reply(who, x.t.threadId, "recovered", m(1)).version).toBe(2);
  } finally {
    x.close();
  }
});
test("CR-180 untrusted or cross-workspace dispatch lookups return no records", () => {
  const x = f();
  try {
    const d = x.s.submit(
      who,
      x.r.reviewId,
      { target, items: [{ threadId: x.t.threadId, version: 1 }] },
      m(),
    );
    const alien = { ...agent, chatIncarnation: "alias-reused" };
    expect(() => x.s.inspectDispatch(alien, d.dispatchId)).toThrow(
      "unavailable",
    );
    expect(x.s.listDispatches(alien)).toEqual([]);
    expect(x.s.listDispatches({ ...who, workspaceId: "elsewhere" })).toEqual(
      [],
    );
    expect(() =>
      x.s.inspectDispatch({ ...who, workspaceId: "elsewhere" }, d.dispatchId),
    ).toThrow("unavailable");
  } finally {
    x.close();
  }
});
