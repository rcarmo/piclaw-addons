import { Database } from "bun:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ReviewError } from "./contracts.js";
export const id = (prefix: string): string => `${prefix}_${randomUUID()}`;
export const now = (): string => new Date().toISOString();
const SCHEMA = 1;
/** A host-owned connection; this add-on neither configures nor closes it. */
export interface BorrowedReviewDatabase {
  database: Database;
  assertOwner(): void;
  admitWrite?<T>(body: () => T): Promise<T>;
}
export type ReviewDatabaseSource = string | BorrowedReviewDatabase;
export type ReviewTable =
  | "reviews" | "blobs" | "snapshots" | "snapshot_files" | "threads"
  | "projections" | "messages" | "message_revisions" | "drafts"
  | "dispatches" | "dispatch_items" | "attempts" | "events"
  | "request_receipts" | "review_settings";
const settingsSchema = (table: (name: ReviewTable) => string) => `
CREATE TABLE IF NOT EXISTS ${table("review_settings")} (
 owner_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 retention_days INTEGER CHECK(retention_days IS NULL OR (retention_days BETWEEN 1 AND 3650)),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,workspace_id)
);`;
/** A string retains the legacy standalone store; an explicit object borrows a host connection. */
export class ReviewDatabase {
  readonly db: Database;
  private readonly borrowed: BorrowedReviewDatabase | null;
  private closed = false;
  constructor(source: ReviewDatabaseSource) {
    this.borrowed = typeof source === "string" ? null : Object.freeze({
      database: source.database,
      assertOwner: source.assertOwner.bind(source),
      admitWrite: source.admitWrite?.bind(source),
    });
    if (this.borrowed) {
      this.borrowed.assertOwner();
      this.db = this.borrowed.database;
      this.initializeBorrowed();
      return;
    }
    const file = source as string;
    if (file === ":memory:") this.db = new Database(file);
    else {
      const resolved = resolve(file);
      const parent = realpathSync(dirname(resolved));
      if (parent !== dirname(resolved))
        throw new ReviewError(
          "unsafe_store",
          "Store parent must be canonical.",
        );
      try {
        const stat = lstatSync(resolved);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new ReviewError(
            "unsafe_store",
            "Store must be a regular file.",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.db = new Database(resolved, { create: true, strict: true });
    }
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      const version = (
        this.db.query("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
      if (version > SCHEMA)
        throw new ReviewError(
          "unsupported_schema",
          "Review store was written by a newer add-on.",
        );
      if (version === 0) {
        const tables = this.db
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();
        if (tables.length)
          throw new ReviewError(
            "unsupported_schema",
            "Unversioned non-empty database is not a review store.",
          );
        this.db
          .transaction(() => {
            this.db.exec(schema((name) => this.table(name), "dispatch_by_thread"));
            this.db.exec(`PRAGMA user_version=${SCHEMA}`);
          })
          .immediate();
      }
      this.db.exec(settingsSchema((name) => this.table(name)));
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  /** Only source-controlled identifiers belong here; SQL and bound values are never rewritten. */
  table(name: ReviewTable): string {
    return this.borrowed ? `addon_code_review_${name}` : name;
  }
  private assertOwner(): void {
    if (this.closed) throw new ReviewError("store_closed", "Review store is closed.");
    this.borrowed?.assertOwner();
  }
  private initializeBorrowed(): void {
    this.transaction(() => {
      // Schema versions are add-on-local. Never read/write the host's user_version.
      this.db.exec(`CREATE TABLE IF NOT EXISTS addon_code_review_schema (
        id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL
      )`);
      const row = this.get<{ version: number }>(
        "SELECT version FROM addon_code_review_schema WHERE id=1",
      );
      if (row && row.version !== SCHEMA)
        throw new ReviewError("unsupported_schema", "Unsupported shared review schema.");
      if (!row) {
        this.db.exec(schema((name) => this.table(name), "addon_code_review_dispatch_by_thread"));
        this.run("INSERT INTO addon_code_review_schema VALUES(1,?)", SCHEMA);
      }
      this.db.exec(settingsSchema((name) => this.table(name)));
    });
  }
  async write<T>(body: () => T): Promise<T> {
    this.assertOwner();
    const result = await (this.borrowed?.admitWrite
      ? this.borrowed.admitWrite(() => this.transaction(body)) : this.transaction(body));
    this.assertOwner(); return result;
  }
  transaction<T>(fn: () => T): T {
    this.assertOwner();
    return this.db.transaction(() => {
      this.assertOwner();
      const result = fn();
      this.assertOwner();
      return result;
    }).immediate();
  }
  get<T>(sql: string, ...params: any[]): T | null {
    this.assertOwner();
    return (this.db.query(sql).get(...params) as T) ?? null;
  }
  all<T>(sql: string, ...params: any[]): T[] {
    this.assertOwner();
    return this.db.query(sql).all(...params) as T[];
  }
  run(sql: string, ...params: any[]) {
    this.assertOwner();
    return this.db.query(sql).run(...params);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.borrowed) this.db.close();
  }
}
const schema = (table: (name: ReviewTable) => string, dispatchIndex: string) => `
CREATE TABLE ${table("reviews")} (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, worktree_id TEXT NOT NULL,
 title TEXT NOT NULL, focus_path TEXT NOT NULL, target_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX ${table("reviews")}_owner ON ${table("reviews")}(owner_id,updated_at,id);
CREATE TABLE ${table("blobs")} (
 review_id TEXT NOT NULL REFERENCES ${table("reviews")}(id), hash TEXT NOT NULL, text TEXT NOT NULL, bytes INTEGER NOT NULL,
 PRIMARY KEY(review_id,hash)
);
CREATE TABLE ${table("snapshots")} (
 id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES ${table("reviews")}(id), mode TEXT NOT NULL,
 base TEXT, head TEXT, captured_at TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(id,review_id)
);
CREATE TABLE ${table("snapshot_files")} (
 id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, review_id TEXT NOT NULL,
 old_path TEXT, new_path TEXT, change_kind TEXT NOT NULL, old_hash TEXT, new_hash TEXT, file_identity TEXT,
 FOREIGN KEY(snapshot_id,review_id) REFERENCES ${table("snapshots")}(id,review_id),
 FOREIGN KEY(review_id,old_hash) REFERENCES ${table("blobs")}(review_id,hash),
 FOREIGN KEY(review_id,new_hash) REFERENCES ${table("blobs")}(review_id,hash), UNIQUE(id,review_id)
);
CREATE INDEX ${table("snapshot_files")}_order ON ${table("snapshot_files")}(snapshot_id,id);
CREATE TABLE ${table("threads")} (
 id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES ${table("reviews")}(id), anchor_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved','deleted')),
 target_json TEXT NOT NULL, assignment_epoch INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(id,review_id)
);
CREATE INDEX ${table("threads")}_review ON ${table("threads")}(review_id,state,id);
CREATE TABLE ${table("projections")} (
 thread_id TEXT NOT NULL, review_id TEXT NOT NULL, snapshot_file_id TEXT NOT NULL, projection_json TEXT NOT NULL,
 actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(thread_id,snapshot_file_id),
 FOREIGN KEY(thread_id,review_id) REFERENCES ${table("threads")}(id,review_id),
 FOREIGN KEY(snapshot_file_id,review_id) REFERENCES ${table("snapshot_files")}(id,review_id)
);
CREATE TABLE ${table("messages")} (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, review_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 author_id TEXT NOT NULL, author_kind TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(thread_id,review_id) REFERENCES ${table("threads")}(id,review_id), UNIQUE(thread_id,ordinal), UNIQUE(id,review_id)
);
CREATE TABLE ${table("message_revisions")} (
 message_id TEXT NOT NULL REFERENCES ${table("messages")}(id), version INTEGER NOT NULL, body TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(message_id,version)
);
CREATE TABLE ${table("drafts")} (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, review_id TEXT NOT NULL REFERENCES ${table("reviews")}(id), thread_id TEXT,
 anchor_json TEXT, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
 FOREIGN KEY(thread_id,review_id) REFERENCES ${table("threads")}(id,review_id)
);
CREATE INDEX ${table("drafts")}_owner ON ${table("drafts")}(owner_id,review_id);
CREATE TABLE ${table("dispatches")} (
 id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES ${table("reviews")}(id), actor_id TEXT NOT NULL,
 target_json TEXT NOT NULL, summary TEXT NOT NULL, payload_hash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, UNIQUE(id,review_id)
);
CREATE TABLE ${table("dispatch_items")} (
 dispatch_id TEXT NOT NULL, review_id TEXT NOT NULL, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 thread_version INTEGER NOT NULL, assignment_epoch INTEGER NOT NULL, snapshot_file_id TEXT NOT NULL,
 work_state TEXT NOT NULL DEFAULT 'not_started', version INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(dispatch_id,review_id) REFERENCES ${table("dispatches")}(id,review_id),
 FOREIGN KEY(thread_id,review_id) REFERENCES ${table("threads")}(id,review_id),
 FOREIGN KEY(snapshot_file_id,review_id) REFERENCES ${table("snapshot_files")}(id,review_id),
 PRIMARY KEY(dispatch_id,thread_id), UNIQUE(dispatch_id,ordinal)
);
CREATE INDEX ${dispatchIndex} ON ${table("dispatch_items")}(thread_id,dispatch_id);
CREATE TABLE ${table("attempts")} (
 id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL REFERENCES ${table("dispatches")}(id), number INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','attempting','accepted','rejected','unknown')),
 host_row_id INTEGER, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(dispatch_id,number)
);
CREATE TABLE ${table("events")} (
 cursor INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL REFERENCES ${table("reviews")}(id),
 thread_id TEXT, dispatch_id TEXT, actor_id TEXT NOT NULL, kind TEXT NOT NULL, data_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(thread_id,review_id) REFERENCES ${table("threads")}(id,review_id),
 FOREIGN KEY(dispatch_id,review_id) REFERENCES ${table("dispatches")}(id,review_id)
);
CREATE INDEX ${table("events")}_review ON ${table("events")}(review_id,cursor);
CREATE TABLE ${table("request_receipts")} (
 owner_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL, action TEXT NOT NULL,
 payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,actor_id,request_id)
);`;
