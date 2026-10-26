import { expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewDatabase, type BorrowedReviewDatabase } from "./database.js";
import { ReviewService } from "./dispatch.js";
import { reviewAction, reviewService, setReviewDatabaseSource } from "./runtime.js";
import type { LocalContext } from "./host.js";
import type { ReviewIdentity, SourceCapture } from "./contracts.js";

const tables = [
  "reviews", "blobs", "snapshots", "snapshot_files", "threads", "projections",
  "messages", "message_revisions", "drafts", "dispatches", "dispatch_items",
  "attempts", "events", "request_receipts", "review_settings",
] as const;
const human: ReviewIdentity = {
  ownerId: "owner", actorId: "human", kind: "operator", workspaceId: "workspace",
};
const target = { chatId: "web:worker", incarnation: "branch", label: "Worker" };
const text = "FROM messages JOIN threads UPDATE tasks; 'reviews' ${events}\n";
let sequence = 0;
const mutation = (expectedVersion?: number) => ({ requestId: `shared-${++sequence}`, expectedVersion });
function capture(): SourceCapture {
  return {
    workspaceId: "workspace", worktreeId: "tree", mode: "source",
    base: null, head: null, capturedAt: new Date().toISOString(),
    files: [{ oldPath: null, newPath: "a.ts", oldText: null, newText: text, change: "source", fileIdentity: "inode" }],
  };
}
function create(service: ReviewService) {
  const request = mutation();
  const input = { title: text, focusPath: "a.ts", target };
  const source = capture();
  const review = service.createFromCapture(human, input, source, request);
  const thread = service.createThread(human, review.reviewId, {
    fileId: review.files[0]!, side: "source", body: text,
  }, mutation());
  return { review, thread, input, source, request };
}
function rootSnapshot(db: Database) {
  return {
    schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'addon_code_review_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),
    rows: [...tables, "tasks"].map(table => [table, db.query(`SELECT * FROM ${table}`).all()]),
  };
}
function pragmas(db: Database) {
  return ["user_version", "foreign_keys", "busy_timeout", "journal_mode", "synchronous"]
    .map(name => db.query(`PRAGMA ${name}`).get());
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-shared-"));
  const db = new Database(join(dir, "root.db"), { strict: true });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA user_version=1650; PRAGMA busy_timeout=123; PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL;");
  // Incompatible sentinel tables catch accidental unqualified queries and writes.
  for (const table of [...tables, "tasks"]) {
    db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, marker TEXT NOT NULL)`);
    db.query(`INSERT INTO ${table} VALUES(?,?)`).run("root-row", text);
  }
  for (const index of ["reviews_owner", "snapshot_files_order", "threads_review", "drafts_owner", "dispatch_by_thread", "events_review"])
    db.exec(`CREATE INDEX ${index} ON tasks(marker)`);
  db.exec("CREATE TRIGGER root_messages_guard BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'root rows are not reviews'); END");
  const before = rootSnapshot(db), config = pragmas(db);
  let active = true, checks = 0;
  const source: BorrowedReviewDatabase = {
    database: db,
    assertOwner() { checks++; if (!active) throw new Error("owner revoked"); },
  };
  const service = new ReviewService(source);
  return {
    dir, db, source, service, before, config,
    revoke() { active = false; }, restore() { active = true; },
    get checks() { return checks; },
    close() { service.close(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("SHAREDDB borrows exactly one connection, namespaces schema/FKs/indexes, preserves host state", () => {
  const f = fixture();
  try {
    expect(f.service.database.db).toBe(f.db);
    expect(pragmas(f.db)).toEqual(f.config);
    expect(rootSnapshot(f.db)).toEqual(f.before);
    expect(f.db.query("SELECT * FROM addon_code_review_schema").all()).toEqual([{ id: 1, version: 1 }]);
    const objects = f.db.query("SELECT type,name,tbl_name FROM sqlite_master WHERE name GLOB 'addon_code_review_*'").all() as { type: string; name: string; tbl_name: string }[];
    expect(objects.filter(row => row.type === "table")).toHaveLength(tables.length + 1);
    expect(objects.filter(row => row.type === "index")).toHaveLength(6);
    for (const row of objects) expect(row.tbl_name.startsWith("addon_code_review_")).toBe(true);
    for (const table of tables) {
      const keys = f.db.query(`PRAGMA foreign_key_list(addon_code_review_${table})`).all() as { table: string }[];
      for (const key of keys) expect(key.table.startsWith("addon_code_review_")).toBe(true);
    }
    const x = create(f.service);
    expect(f.service.readFile(human, x.review.reviewId, x.review.files[0]!).newText).toBe(text);
    expect(f.service.getReview(human, x.review.reviewId).title).toBe(text);
    expect(f.service.database.get<{ literal: string; bound: string }>("SELECT 'FROM messages JOIN threads' AS literal, ? AS bound", text))
      .toEqual({ literal: "FROM messages JOIN threads", bound: text });
    expect(f.db.query("PRAGMA database_list").all()).toHaveLength(1);
    expect(readdirSync(f.dir)).toEqual(["root.db"]);
    const peer = new ReviewService(f.source);
    expect(peer.getThread(human, x.thread.threadId).messages[0]!.body).toBe(text);
    peer.close();
    expect(f.service.listReviews(human)).toHaveLength(1);
    f.service.close(); f.service.close();
    expect(() => f.service.listReviews(human)).toThrow("closed");
    expect(f.db.query("SELECT 1 AS alive").get()).toEqual({ alive: 1 });
    expect(pragmas(f.db)).toEqual(f.config);
    expect(rootSnapshot(f.db)).toEqual(f.before);
  } finally { f.close(); }
});

test("SHAREDDB discussion, drafts, projections, dispatch and runtime file counts use only shared tables", async () => {
  const f = fixture();
  try {
    const s = f.service, x = create(s), id = x.review.reviewId, threadId = x.thread.threadId;
    const replyRequest = mutation(1);
    const reply = s.reply(human, threadId, text, replyRequest);
    expect(s.reply(human, threadId, text, replyRequest)).toEqual(reply);
    expect(s.replyReceipt(human, id, replyRequest.requestId, threadId).committed).toBe(true);
    expect(s.editMessage(human, reply.messageId, text + "edit", mutation(1)).threadVersion).toBe(3);
    const draft = s.saveDraft(human, id, { threadId, body: text }, mutation());
    expect(s.listDrafts(human, id)).toHaveLength(1);
    s.deleteDraft(human, id, draft.draftId, mutation(1));
    s.reanchor(human, threadId, { fileId: x.review.files[0]!, side: "source" }, mutation(3));
    expect(s.project(human, threadId, x.review.files[0]!)).toMatchObject({ method: "manual" });
    expect(s.listThreads(human, id)[0]!.summary.messageCount).toBe(2);
    const ctx: LocalContext = {
      version: 1, accessMode: "single-user", ownerId: human.ownerId, actorId: human.actorId,
      kind: "operator", workspaceRoot: f.dir, workspaceId: "workspace",
      async listTargets() { return []; }, async resolveTarget() { return null; },
      async enqueue() { throw new Error("not used"); },
    };
    const files = await reviewAction(ctx, "files", { reviewId: id, snapshotId: x.review.snapshotId }, s) as { stats: { openThreads: number } }[];
    expect(files[0]!.stats.openThreads).toBe(1);
    const d = s.submit(human, id, { target, items: [{ threadId, version: 4 }], summary: text }, mutation());
    const sent = await s.deliver(human, d.dispatchId, { async enqueue() { return { status: "accepted", rowId: 42 }; } });
    expect(sent.attempts[0]!.state).toBe("accepted");
    const agent: ReviewIdentity = { ...human, actorId: "agent", kind: "agent", chatId: target.chatId,
      chatIncarnation: target.incarnation, reference: { addonId: "code-review", intentId: d.dispatchId } };
    expect(s.agentDispatchScope(agent, d.dispatchId).threadIds).toEqual([threadId]);
    expect(s.listDispatches(agent)).toHaveLength(1);
    expect(s.listScopedThreads(agent, d.dispatchId)).toHaveLength(1);
    expect(s.listThreads(agent, id)).toHaveLength(1);
    s.resolveThread(agent, threadId, { fileId: x.review.files[0]!, explanation: text, assignmentEpoch: 1 }, mutation(4));
    s.updateWork(agent, d.dispatchId, threadId, { state: "completed", itemVersion: 1, threadVersion: 5, assignmentEpoch: 1 }, mutation());
    expect(s.getThread(agent, threadId).messages.at(-1)).toMatchObject({ body: text, resolution: { fileId: x.review.files[0]! } });
    expect(s.events(human, id).length).toBeGreaterThan(5);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(rootSnapshot(f.db)).toEqual(f.before);
    expect(pragmas(f.db)).toEqual(f.config);
  } finally { f.close(); }
});

test("SHAREDDB nested mutations join host rollback; failing namespaced trigger rolls back all reply writes", () => {
  const f = fixture();
  try {
    expect(() => f.db.transaction(() => {
      create(f.service);
      throw new Error("host rollback");
    }).immediate()).toThrow("host rollback");
    expect(f.service.listReviews(human)).toEqual([]);
    expect(f.db.query("SELECT * FROM addon_code_review_request_receipts").all()).toEqual([]);
    const x = create(f.service);
    f.db.exec("CREATE TRIGGER addon_code_review_fail_reply BEFORE INSERT ON addon_code_review_message_revisions WHEN NEW.body='blocked' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    const before = f.service.getThread(human, x.thread.threadId);
    const request = mutation(1);
    expect(() => f.service.reply(human, x.thread.threadId, "blocked", request)).toThrow("injected failure");
    expect(f.service.getThread(human, x.thread.threadId)).toEqual(before);
    f.db.exec("DROP TRIGGER addon_code_review_fail_reply");
    expect(f.service.reply(human, x.thread.threadId, "blocked", request).version).toBe(2);
    expect(rootSnapshot(f.db)).toEqual(f.before);
  } finally { f.close(); }
});

test("SHAREDDB retention/deletion isolate owners and preserve body-free tombstones", () => {
  const f = fixture();
  try {
    const x = create(f.service), keep = create(f.service);
    f.service.saveDraft(human, x.review.reviewId, { threadId: x.thread.threadId, body: text }, mutation());
    f.service.submit(human, x.review.reviewId, { target, items: [{ threadId: x.thread.threadId, version: 1 }] }, mutation());
    expect(() => f.service.deleteReview({ ...human, ownerId: "other" }, { reviewId: x.review.reviewId, ...mutation(1) })).toThrow("unavailable");
    const deletion = { reviewId: x.review.reviewId, ...mutation(1) };
    expect(f.service.deleteReview(human, deletion).deleted).toBe(true);
    expect(f.service.deleteReview(human, deletion).deleted).toBe(true);
    expect(() => f.service.createFromCapture(human, x.input, x.source, x.request)).toThrow("unavailable");
    for (const table of tables.filter(table => !["reviews", "review_settings", "request_receipts"].includes(table)))
      expect(JSON.stringify(f.db.query(`SELECT * FROM addon_code_review_${table}`).all())).not.toContain(x.thread.threadId);
    const old = "2020-01-01T00:00:00.000Z";
    f.db.query("UPDATE addon_code_review_reviews SET updated_at=?").run(old);
    f.db.query("UPDATE addon_code_review_events SET created_at=?").run(old);
    expect(f.service.cleanupOldReviews(human).deletedCount).toBe(0);
    f.service.saveSettings(human, 1);
    expect(f.service.getSettings(human).retentionDays).toBe(1);
    expect(f.service.cleanupConfiguredReviews("other-workspace")).toBe(0);
    expect(f.service.cleanupConfiguredReviews("workspace")).toBe(1);
    expect(() => f.service.getReview(human, keep.review.reviewId)).toThrow("unavailable");
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(rootSnapshot(f.db)).toEqual(f.before);
  } finally { f.close(); }
});

test("SHAREDDB checks ownership before every operation and before transaction commit", () => {
  const f = fixture();
  try {
    const db = f.service.database, beforeChecks = f.checks;
    db.get("SELECT 1"); db.all("SELECT 1"); db.run("SELECT 1"); db.transaction(() => 1);
    expect(f.checks - beforeChecks).toBe(6);
    f.revoke();
    for (const op of [() => db.get("SELECT 1"), () => db.all("SELECT 1"), () => db.run("SELECT 1"), () => db.transaction(() => 1)])
      expect(op).toThrow("owner revoked");
    expect(() => new ReviewDatabase(f.source)).toThrow("owner revoked");
    f.restore();
    expect(() => db.transaction(() => {
      create(f.service);
      f.revoke();
    })).toThrow("owner revoked");
    f.restore();
    expect(f.service.listReviews(human)).toEqual([]);
    expect(rootSnapshot(f.db)).toEqual(f.before);
    f.revoke(); f.service.close(); // Detach even when the host is no longer current.
    expect(f.db.query("SELECT 1 AS alive").get()).toEqual({ alive: 1 });
  } finally { f.close(); }
});

test("SHAREDDB revoked owner cannot settle an awaited enqueue; next owner recovers uncertainty", async () => {
  const f = fixture();
  try {
    const x = create(f.service);
    const d = f.service.submit(human, x.review.reviewId, { target, items: [{ threadId: x.thread.threadId, version: 1 }] }, mutation());
    await expect(f.service.deliver(human, d.dispatchId, { async enqueue() {
      f.revoke();
      // Reusing a caller-owned descriptor must not replace the old grant.
      f.source.assertOwner = () => {};
      return { status: "accepted", rowId: 99 };
    } })).rejects.toThrow("owner revoked");
    expect(f.db.query("SELECT state,host_row_id FROM addon_code_review_attempts").get()).toEqual({ state: "attempting", host_row_id: null });
    f.service.close(); f.restore();
    const next = new ReviewService(f.source);
    try {
      expect(next.recoverInterrupted()).toBe(1);
      expect(next.inspectDispatch(human, d.dispatchId).attempts[0]!.state).toBe("unknown");
    } finally { next.close(); }
    expect(rootSnapshot(f.db)).toEqual(f.before);
  } finally { f.close(); }
});

test("SHAREDDB unsupported schema or colliding shared table fails atomically without closing host", () => {
  const db = new Database(":memory:");
  const source: BorrowedReviewDatabase = { database: db, assertOwner() {} };
  try {
    db.exec("PRAGMA user_version=999; CREATE TABLE addon_code_review_threads(sentinel TEXT); INSERT INTO addon_code_review_threads VALUES('keep')");
    expect(() => new ReviewDatabase(source)).toThrow();
    expect(db.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()).toEqual([{ name: "addon_code_review_threads" }]);
    expect(db.query("SELECT * FROM addon_code_review_threads").all()).toEqual([{ sentinel: "keep" }]);
    db.exec("CREATE TABLE addon_code_review_schema(id INTEGER PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO addon_code_review_schema VALUES(1,2)");
    const before = db.query("SELECT * FROM sqlite_master ORDER BY name").all();
    expect(() => new ReviewDatabase(source)).toThrow("Unsupported shared review schema");
    expect(db.query("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 999 });
  } finally { db.close(); }
});

test("SHAREDDB is opt-in: legacy standalone schema/data/settings remain unchanged and are not migrated", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-legacy-")), path = join(dir, "reviews.db");
  let standalone = new ReviewService(path);
  let host: Database | undefined;
  try {
    const x = create(standalone);
    standalone.saveSettings(human, 7);
    const schema = standalone.database.all("SELECT * FROM sqlite_master ORDER BY name");
    standalone.close(); standalone = new ReviewService(path);
    expect(standalone.database.all("SELECT * FROM sqlite_master ORDER BY name")).toEqual(schema);
    expect(standalone.getThread(human, x.thread.threadId).messages[0]!.body).toBe(text);
    expect(standalone.getSettings(human).retentionDays).toBe(7);
    standalone.close(); host = new Database(path);
    const borrowed = new ReviewService({ database: host, assertOwner() {} });
    expect(borrowed.listReviews(human)).toEqual([]); // No implicit copy, fallback or deletion.
    borrowed.close();
    expect(host.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 1 });
    expect(host.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    standalone = new ReviewService(path);
    expect(standalone.getThread(human, x.thread.threadId).messages[0]!.body).toBe(text);
  } finally { standalone.close(); host?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SHAREDDB lifecycle retains all 16 documented owners across deactivation and reinstall", async () => {
  const f = fixture();
  const clear = spyOn(globalThis, "clearInterval");
  let release: (() => void) | undefined, releaseNext: (() => void) | undefined;
  try {
    const x = create(f.service), s = f.service;
    const reply = s.reply(human, x.thread.threadId, "original reply", mutation(1));
    s.editMessage(human, reply.messageId, "edited reply", mutation(1));
    s.reanchor(human, x.thread.threadId, { fileId: x.review.files[0]!, side: "source" }, mutation(3));
    s.saveDraft(human, x.review.reviewId, { threadId: x.thread.threadId, body: "private draft" }, mutation());
    s.saveSettings(human, null);
    const dispatch = s.submit(human, x.review.reviewId, { target, items: [{ threadId: x.thread.threadId, version: 4 }] }, mutation());
    await s.deliver(human, dispatch.dispatchId, { async enqueue() { return { status: "accepted", rowId: 42 }; } });
    const names = ["schema", ...tables].map(name => `addon_code_review_${name}`).sort();
    const objects = () => f.db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'addon_code_review_*' ORDER BY name").all();
    const rows = () => names.map(name => f.db.query(`SELECT * FROM ${name} ORDER BY rowid`).all());
    expect(f.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'addon_code_review_*' ORDER BY name").all())
      .toEqual(names.map(name => ({ name })));
    for (const data of rows()) expect(data.length).toBeGreaterThan(0);
    const savedObjects = objects(), savedRows = rows();
    release = setReviewDatabaseSource(f.source);
    const active = reviewService();
    expect(active.database.db).toBe(f.db);
    expect(rows()).toEqual(savedRows);
    release();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(() => active.listReviews(human)).toThrow("closed");
    expect(objects()).toEqual(savedObjects);
    expect(rows()).toEqual(savedRows);
    // No service is opened in the inactive interval. Core keeps the same file.
    expect(f.db.query("SELECT marker FROM tasks").all()).toEqual([{ marker: text }]);
    releaseNext = setReviewDatabaseSource(f.source);
    const reinstalled = reviewService();
    release(); // A stale incarnation's release cannot close the new one.
    expect(reinstalled.readFile(human, x.review.reviewId, x.review.files[0]!).newText).toBe(text);
    expect(reinstalled.inspectDispatch(human, dispatch.dispatchId).attempts[0]!.state).toBe("accepted");
    expect(reinstalled.getThread(human, x.thread.threadId).messages.at(-1)!.body).toBe("edited reply");
    expect(reinstalled.listDrafts(human, x.review.reviewId)).toHaveLength(1);
    expect(reinstalled.createFromCapture(human, x.input, x.source, x.request)).toEqual(x.review);
    expect(() => reinstalled.createFromCapture(human, { ...x.input, title: "different" }, x.source, x.request)).toThrow("different action or payload");
    expect(reinstalled.cleanupOldReviews(human).deletedCount).toBe(0);
    expect(objects()).toEqual(savedObjects);
    expect(rows()).toEqual(savedRows);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(pragmas(f.db)).toEqual(f.config);
    expect(rootSnapshot(f.db)).toEqual(f.before);
    const readme = readFileSync(join(import.meta.dir, "README.md"), "utf8");
    for (const name of names) expect(readme).toContain(`\`${name}\``);
  } finally { releaseNext?.(); release?.(); clear.mockRestore(); f.close(); }
});

test("SHAREDDB lifecycle schema1 settings initialization remains add-on-owned", () => {
  const f = fixture();
  try {
    const x = create(f.service);
    f.service.close();
    f.db.exec("DROP TABLE addon_code_review_review_settings");
    const before = rootSnapshot(f.db);
    const reopened = new ReviewService(f.source);
    try {
      expect(reopened.getSettings(human)).toEqual({ retentionDays: null });
      expect(reopened.readFile(human, x.review.reviewId, x.review.files[0]!).newText).toBe(text);
      expect(f.db.query("SELECT * FROM addon_code_review_schema").all()).toEqual([{ id: 1, version: 1 }]);
      expect(f.db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name GLOB 'addon_code_review_*'").get()).toEqual({ n: 16 });
      expect(rootSnapshot(f.db)).toEqual(before);
      expect(pragmas(f.db)).toEqual(f.config);
      expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { reopened.close(); }
  } finally { f.close(); }
});
