import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewService } from "./dispatch.js";
import type {
  LocalTarget,
  OriginalAnchor,
  ReviewIdentity,
  SourceCapture,
} from "./contracts.js";

const operator: ReviewIdentity = {
  ownerId: "owner:cr-183",
  actorId: "operator:cr-183",
  kind: "operator",
  workspaceId: "workspace:cr-183",
};
const target: LocalTarget = {
  chatId: "web:code-review-worker",
  incarnation: "branch:cr-183",
  label: "Worker",
};
const SOURCE_TEXT = "alpha\nbeta\ngamma\n";
const TABLES = [
  "reviews",
  "blobs",
  "snapshots",
  "snapshot_files",
  "threads",
  "projections",
  "messages",
  "message_revisions",
  "drafts",
  "dispatches",
  "dispatch_items",
  "attempts",
  "events",
  "request_receipts",
] as const;
const ORPHAN_QUERIES = {
  snapshots_missing_review:
    "SELECT COUNT(*) AS n FROM snapshots s LEFT JOIN reviews r ON r.id=s.review_id WHERE r.id IS NULL",
  snapshot_files_missing_snapshot:
    "SELECT COUNT(*) AS n FROM snapshot_files sf LEFT JOIN snapshots s ON s.id=sf.snapshot_id AND s.review_id=sf.review_id WHERE s.id IS NULL",
  snapshot_files_missing_old_blob:
    "SELECT COUNT(*) AS n FROM snapshot_files sf LEFT JOIN blobs b ON b.review_id=sf.review_id AND b.hash=sf.old_hash WHERE sf.old_hash IS NOT NULL AND b.hash IS NULL",
  snapshot_files_missing_new_blob:
    "SELECT COUNT(*) AS n FROM snapshot_files sf LEFT JOIN blobs b ON b.review_id=sf.review_id AND b.hash=sf.new_hash WHERE sf.new_hash IS NOT NULL AND b.hash IS NULL",
  threads_missing_review:
    "SELECT COUNT(*) AS n FROM threads t LEFT JOIN reviews r ON r.id=t.review_id WHERE r.id IS NULL",
  projections_missing_thread:
    "SELECT COUNT(*) AS n FROM projections p LEFT JOIN threads t ON t.id=p.thread_id AND t.review_id=p.review_id WHERE t.id IS NULL",
  projections_missing_file:
    "SELECT COUNT(*) AS n FROM projections p LEFT JOIN snapshot_files sf ON sf.id=p.snapshot_file_id AND sf.review_id=p.review_id WHERE sf.id IS NULL",
  messages_missing_thread:
    "SELECT COUNT(*) AS n FROM messages m LEFT JOIN threads t ON t.id=m.thread_id AND t.review_id=m.review_id WHERE t.id IS NULL",
  message_revisions_missing_message:
    "SELECT COUNT(*) AS n FROM message_revisions mr LEFT JOIN messages m ON m.id=mr.message_id WHERE m.id IS NULL",
  drafts_missing_review:
    "SELECT COUNT(*) AS n FROM drafts d LEFT JOIN reviews r ON r.id=d.review_id WHERE r.id IS NULL",
  drafts_missing_thread:
    "SELECT COUNT(*) AS n FROM drafts d LEFT JOIN threads t ON t.id=d.thread_id AND t.review_id=d.review_id WHERE d.thread_id IS NOT NULL AND t.id IS NULL",
  dispatches_missing_review:
    "SELECT COUNT(*) AS n FROM dispatches d LEFT JOIN reviews r ON r.id=d.review_id WHERE r.id IS NULL",
  dispatch_items_missing_dispatch:
    "SELECT COUNT(*) AS n FROM dispatch_items i LEFT JOIN dispatches d ON d.id=i.dispatch_id AND d.review_id=i.review_id WHERE d.id IS NULL",
  dispatch_items_missing_thread:
    "SELECT COUNT(*) AS n FROM dispatch_items i LEFT JOIN threads t ON t.id=i.thread_id AND t.review_id=i.review_id WHERE t.id IS NULL",
  dispatch_items_missing_file:
    "SELECT COUNT(*) AS n FROM dispatch_items i LEFT JOIN snapshot_files sf ON sf.id=i.snapshot_file_id AND sf.review_id=i.review_id WHERE sf.id IS NULL",
  attempts_missing_dispatch:
    "SELECT COUNT(*) AS n FROM attempts a LEFT JOIN dispatches d ON d.id=a.dispatch_id WHERE d.id IS NULL",
  events_missing_review:
    "SELECT COUNT(*) AS n FROM events e LEFT JOIN reviews r ON r.id=e.review_id WHERE r.id IS NULL",
  events_missing_thread:
    "SELECT COUNT(*) AS n FROM events e LEFT JOIN threads t ON t.id=e.thread_id AND t.review_id=e.review_id WHERE e.thread_id IS NOT NULL AND t.id IS NULL",
  events_missing_dispatch:
    "SELECT COUNT(*) AS n FROM events e LEFT JOIN dispatches d ON d.id=e.dispatch_id AND d.review_id=e.review_id WHERE e.dispatch_id IS NOT NULL AND d.id IS NULL",
} as const;

type TableName = (typeof TABLES)[number];
type Counts = Record<TableName, number>;
type OrphanName = keyof typeof ORPHAN_QUERIES;
type OrphanCounts = Record<OrphanName, number>;

let serial = 0;
const mutation = (expectedVersion?: number) => ({
  requestId: `cr-183-${++serial}`,
  expectedVersion,
});

function capture(worktreeId: string, path: string): SourceCapture {
  return {
    workspaceId: operator.workspaceId!,
    worktreeId,
    mode: "source",
    base: null,
    head: null,
    capturedAt: new Date().toISOString(),
    files: [
      {
        oldPath: null,
        newPath: path,
        change: "source",
        oldText: null,
        newText: SOURCE_TEXT,
        fileIdentity: `inode:${worktreeId}:${path}`,
      },
    ],
  };
}

function countTablesFromService(service: ReviewService): Counts {
  const entries = TABLES.map(
    (table) =>
      [
        table,
        service.database.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
          ?.n ?? 0,
      ] as const,
  );
  return Object.fromEntries(entries) as Counts;
}

function countTablesFromDatabase(db: Database): Counts {
  const entries = TABLES.map((table) => {
    const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    return [table, row.n] as const;
  });
  return Object.fromEntries(entries) as Counts;
}

function orphanCountsFromService(service: ReviewService): OrphanCounts {
  const entries = (
    Object.entries(ORPHAN_QUERIES) as Array<[
      OrphanName,
      (typeof ORPHAN_QUERIES)[OrphanName],
    ]>
  ).map(([name, sql]) => {
    const row = service.database.get<{ n: number }>(sql);
    return [name, row?.n ?? 0] as const;
  });
  return Object.fromEntries(entries) as OrphanCounts;
}

function orphanCountsFromDatabase(db: Database): OrphanCounts {
  const entries = (
    Object.entries(ORPHAN_QUERIES) as Array<[
      OrphanName,
      (typeof ORPHAN_QUERIES)[OrphanName],
    ]>
  ).map(([name, sql]) => {
    const row = db.query(sql).get() as { n: number };
    return [name, row.n] as const;
  });
  return Object.fromEntries(entries) as OrphanCounts;
}

function zeroOrphans(): OrphanCounts {
  const entries = (Object.keys(ORPHAN_QUERIES) as OrphanName[]).map((name) => [
    name,
    0,
  ] as const);
  return Object.fromEntries(entries) as OrphanCounts;
}

function assertLiveIntegrity(service: ReviewService, expectedCounts?: Counts) {
  expect(
    service.database.get<{ foreign_keys: number }>("PRAGMA foreign_keys")
      ?.foreign_keys,
  ).toBe(1);
  expect(service.database.all<Record<string, unknown>>("PRAGMA foreign_key_check")).toEqual(
    [],
  );
  expect(orphanCountsFromService(service)).toEqual(zeroOrphans());
  if (expectedCounts) expect(countTablesFromService(service)).toEqual(expectedCounts);
}

function expectRejectedWithoutChange(
  service: ReviewService,
  action: () => unknown,
  message: string,
) {
  const before = countTablesFromService(service);
  expect(action).toThrow(message);
  expect(countTablesFromService(service)).toEqual(before);
  assertLiveIntegrity(service, before);
}

function assertPersistedIntegrity(path: string, expectedCounts: Counts) {
  const db = new Database(path);
  try {
    db.exec("PRAGMA foreign_keys=ON;");
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(orphanCountsFromDatabase(db)).toEqual(zeroOrphans());
    expect(countTablesFromDatabase(db)).toEqual(expectedCounts);
  } finally {
    db.close();
  }
}

function fileHash(service: ReviewService, fileId: string): string {
  return (
    service.database.get<{ new_hash: string }>(
      "SELECT new_hash FROM snapshot_files WHERE id=?",
      fileId,
    )?.new_hash ?? ""
  );
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "code-review-reference-integrity-"));
  const path = join(dir, "reviews.db");
  const service = new ReviewService(path);
  let closed = false;

  const review1 = service.createReview(
    operator,
    {
      workspaceId: operator.workspaceId!,
      worktreeId: "worktree:one",
      title: "Review one",
      focusPath: "src/one.ts",
      target,
    },
    mutation(),
  ).reviewId;
  const file1 = service.capture(
    operator,
    review1,
    capture("worktree:one", "src/one.ts"),
    mutation(),
  ).files[0]!;
  const thread1 = service.createThread(
    operator,
    review1,
    {
      fileId: file1,
      side: "source",
      range: { startLine: 2, endLine: 2 },
      body: "Review one concern",
    },
    mutation(),
  );

  const review2 = service.createReview(
    operator,
    {
      workspaceId: operator.workspaceId!,
      worktreeId: "worktree:two",
      title: "Review two",
      focusPath: "src/two.ts",
      target,
    },
    mutation(),
  ).reviewId;
  const file2 = service.capture(
    operator,
    review2,
    capture("worktree:two", "src/two.ts"),
    mutation(),
  ).files[0]!;
  const thread2 = service.createThread(
    operator,
    review2,
    {
      fileId: file2,
      side: "source",
      range: { startLine: 2, endLine: 2 },
      body: "Review two concern",
    },
    mutation(),
  );

  return {
    dir,
    path,
    service,
    review1,
    file1,
    thread1,
    review2,
    file2,
    thread2,
    close() {
      if (!closed) {
        service.close();
        closed = true;
      }
    },
    cleanup() {
      if (!closed) {
        service.close();
        closed = true;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("CR-183 resolveThread rejects cross-review file references atomically even when digests match", () => {
  const f = fixture();
  try {
    expect(fileHash(f.service, f.file1)).toBe(fileHash(f.service, f.file2));

    const before = countTablesFromService(f.service);
    const thread = f.service.getThread(operator, f.thread1.threadId);
    const eventCount = f.service.events(operator, f.review1).length;

    expectRejectedWithoutChange(
      f.service,
      () =>
        f.service.resolveThread(
          operator,
          f.thread1.threadId,
          {
            explanation: "Should not cross reviews",
            fileId: f.file2,
            evidence: ["same-bytes-are-not-ownership"],
          },
          mutation(thread.version),
        ),
      "unavailable",
    );

    const unchanged = f.service.getThread(operator, f.thread1.threadId);
    expect(unchanged.state).toBe("open");
    expect(unchanged.version).toBe(thread.version);
    expect(unchanged.messages).toHaveLength(thread.messages.length);
    expect(f.service.events(operator, f.review1).length).toBe(eventCount);

    assertLiveIntegrity(f.service, before);
    f.close();
    assertPersistedIntegrity(f.path, before);
  } finally {
    f.cleanup();
  }
});

test("CR-183 saveDraft rejects cross-review and dangling file anchors atomically", () => {
  const f = fixture();
  try {
    expect(fileHash(f.service, f.file1)).toBe(fileHash(f.service, f.file2));

    const crossReviewAnchor = f.service.makeAnchor(
      operator,
      f.review2,
      f.file2,
      "source",
      { startLine: 2, endLine: 2 },
    );
    expectRejectedWithoutChange(
      f.service,
      () =>
        f.service.saveDraft(
          operator,
          f.review1,
          { anchor: crossReviewAnchor, body: "cross-review draft" },
          mutation(),
        ),
      "unavailable",
    );
    expect(f.service.listDrafts(operator, f.review1)).toEqual([]);

    const danglingAnchor: OriginalAnchor = {
      ...f.service.makeAnchor(operator, f.review1, f.file1, "source", {
        startLine: 2,
        endLine: 2,
      }),
      snapshotFileId: "file_missing",
    };
    const before = countTablesFromService(f.service);
    expectRejectedWithoutChange(
      f.service,
      () =>
        f.service.saveDraft(
          operator,
          f.review1,
          { anchor: danglingAnchor, body: "dangling draft" },
          mutation(),
        ),
      "unavailable",
    );
    expect(f.service.listDrafts(operator, f.review1)).toEqual([]);

    assertLiveIntegrity(f.service, before);
    f.close();
    assertPersistedIntegrity(f.path, before);
  } finally {
    f.cleanup();
  }
});

test("CR-183 submit rejects cross-review and dangling thread selections atomically", () => {
  const f = fixture();
  try {
    expectRejectedWithoutChange(
      f.service,
      () =>
        f.service.submit(
          operator,
          f.review1,
          {
            target,
            items: [{ threadId: f.thread2.threadId, version: f.thread2.version }],
            summary: "cross-review dispatch",
          },
          mutation(),
        ),
      "unavailable",
    );
    expect(f.service.listDispatches(operator, f.review1)).toEqual([]);

    const before = countTablesFromService(f.service);
    expectRejectedWithoutChange(
      f.service,
      () =>
        f.service.submit(
          operator,
          f.review1,
          {
            target,
            items: [{ threadId: "thread_missing", version: 1 }],
            summary: "dangling dispatch",
          },
          mutation(),
        ),
      "unavailable",
    );
    expect(f.service.listDispatches(operator, f.review1)).toEqual([]);

    assertLiveIntegrity(f.service, before);
    f.close();
    assertPersistedIntegrity(f.path, before);
  } finally {
    f.cleanup();
  }
});
