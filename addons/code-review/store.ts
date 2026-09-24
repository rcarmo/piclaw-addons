import { ReviewDatabase, id, now } from "./database.js";
import { createAnchor, projectAnchor } from "./anchors.js";
import {
  LIMITS,
  ReviewError,
  type ReviewIdentity,
  type LocalTarget,
  type SourceCapture,
  type OriginalAnchor,
  type Mutation,
  type WorkState,
} from "./contracts.js";
import {
  boundedText,
  hashText,
  identity,
  operator,
  pageSize,
  stableJson,
  target,
  validId,
  version,
} from "./validation.js";
export interface ReviewRecord {
  id: string;
  owner_id: string;
  workspace_id: string;
  worktree_id: string;
  title: string;
  focus_path: string;
  target_json: string;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface ThreadRecord {
  id: string;
  review_id: string;
  anchor_json: string;
  state: "open" | "resolved" | "deleted";
  target_json: string;
  assignment_epoch: number;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface SnapshotFileRecord {
  id: string;
  snapshot_id: string;
  review_id: string;
  old_path: string | null;
  new_path: string | null;
  old_hash: string | null;
  new_hash: string | null;
  file_identity: string | null;
  change_kind: string;
}
interface MessageRecord {
  id: string;
  thread_id: string;
  review_id: string;
  ordinal: number;
  author_id: string;
  author_kind: string;
  version: number;
  deleted: number;
  created_at: string;
  updated_at: string;
}
export class ReviewStore {
  readonly database: ReviewDatabase;
  constructor(path: string) {
    this.database = new ReviewDatabase(path);
  }
  close() {
    this.database.close();
  }
  protected missing(): never {
    throw new ReviewError("not_found", "Review record is unavailable.", 404);
  }
  protected mutation<T>(
    who: ReviewIdentity,
    m: Mutation,
    action: string,
    payload: unknown,
    run: () => T,
  ): T {
    identity(who);
    validId(m.requestId, "request ID");
    const digest = hashText(stableJson({ action, payload }));
    return this.database.transaction(() => {
      const existing = this.database.get<{
        payload_hash: string;
        result_json: string;
      }>(
        "SELECT * FROM request_receipts WHERE owner_id=? AND actor_id=? AND request_id=?",
        who.ownerId,
        who.actorId,
        m.requestId,
      );
      if (existing) {
        if (existing.payload_hash !== digest)
          throw new ReviewError(
            "conflict",
            "Request ID already has a different action or payload.",
            409,
          );
        return JSON.parse(existing.result_json) as T;
      }
      const result = run(); // Store only IDs/versions: receipts never cache comment text.
      this.database.run(
        "INSERT INTO request_receipts VALUES(?,?,?,?,?,?,?)",
        who.ownerId,
        who.actorId,
        m.requestId,
        action,
        digest,
        JSON.stringify(result),
        now(),
      );
      return result;
    });
  }
  /** Body-free lookup for an operator whose reply acknowledgement was lost. */
  replyReceipt(who: ReviewIdentity, reviewId: string, requestId: string, threadId: string) {
    operator(who);
    this.own(who, reviewId);
    validId(requestId, "request ID");
    const thread = this.thread(who, threadId, true);
    if (thread.review_id !== reviewId) this.missing();
    const receipt = this.database.get<{ result_json: string }>(
      "SELECT result_json FROM request_receipts WHERE owner_id=? AND actor_id=? AND request_id=? AND action='reply'",
      who.ownerId, who.actorId, requestId,
    );
    if (!receipt) return { committed: false };
    const result = JSON.parse(receipt.result_json) as { threadId?: string; messageId?: string };
    if (result.threadId !== threadId || !result.messageId) this.missing();
    // Deleted messages can still have a body-free receipt, but never resurrect content.
    const message = this.database.get<{ id: string }>(
      "SELECT id FROM messages WHERE id=? AND thread_id=? AND review_id=?",
      result.messageId, threadId, reviewId,
    );
    if (!message) this.missing();
    return { committed: true, threadId, messageId: message.id };
  }
  protected event(
    who: ReviewIdentity,
    reviewId: string,
    kind: string,
    data: Record<string, unknown>,
    threadId: string | null = null,
    dispatchId: string | null = null,
  ) {
    this.database.run(
      "INSERT INTO events(review_id,thread_id,dispatch_id,actor_id,kind,data_json,created_at) VALUES(?,?,?,?,?,?,?)",
      reviewId,
      threadId,
      dispatchId,
      who.actorId,
      kind,
      JSON.stringify(data),
      now(),
    );
  }
  protected own(who: ReviewIdentity, reviewId: string): ReviewRecord {
    identity(who);
    validId(reviewId);
    const record = this.database.get<ReviewRecord>(
      "SELECT * FROM reviews WHERE id=? AND owner_id=?",
      reviewId,
      who.ownerId,
    );
    if (!record || (who.workspaceId && who.workspaceId !== record.workspace_id))
      return this.missing();
    return record;
  }
  protected assigned(who: ReviewIdentity, thread: ThreadRecord): void {
    this.own(who, thread.review_id);
    if (who.kind === "agent") {
      const selected = JSON.parse(thread.target_json) as LocalTarget;
      if (
        selected.chatId !== who.chatId ||
        selected.incarnation !== who.chatIncarnation
      )
        this.missing();
    }
  }
  protected thread(
    who: ReviewIdentity,
    threadId: string,
    includeDeleted = false,
  ): ThreadRecord {
    validId(threadId);
    const record = this.database.get<ThreadRecord>(
      "SELECT * FROM threads WHERE id=?",
      threadId,
    );
    if (!record || (!includeDeleted && record.state === "deleted"))
      return this.missing();
    this.assigned(who, record);
    return record;
  }
  protected epoch(
    who: ReviewIdentity,
    thread: ThreadRecord,
    expected?: number,
  ) {
    if (who.kind === "agent" && expected !== thread.assignment_epoch)
      throw new ReviewError("conflict", "Thread assignment changed.", 409);
  }
  protected file(
    who: ReviewIdentity,
    reviewId: string,
    fileId: string,
  ): SnapshotFileRecord {
    this.own(who, reviewId);
    const file = this.database.get<SnapshotFileRecord>(
      "SELECT * FROM snapshot_files WHERE id=? AND review_id=?",
      fileId,
      reviewId,
    );
    if (!file) return this.missing();
    return file;
  }
  protected source(
    file: SnapshotFileRecord,
    side: "old" | "new" | "source",
  ): string {
    if (!["old", "new", "source"].includes(side))
      throw new ReviewError("invalid_anchor", "Unknown source side.");
    if (
      side === "source" &&
      file.change_kind !== "source" &&
      file.change_kind !== "unchanged"
    )
      throw new ReviewError(
        "invalid_anchor",
        "Diff anchors require old or new side.",
      );
    const hash = side === "old" ? file.old_hash : file.new_hash;
    if (!hash)
      throw new ReviewError(
        "invalid_anchor",
        "That snapshot side has no source.",
      );
    const row = this.database.get<{ text: string }>(
      "SELECT text FROM blobs WHERE review_id=? AND hash=?",
      file.review_id,
      hash,
    );
    if (!row) return this.missing();
    return row.text;
  }
  createReview(
    who: ReviewIdentity,
    input: {
      workspaceId: string;
      worktreeId: string;
      title: string;
      focusPath: string;
      target: LocalTarget;
    },
    m: Mutation,
  ) {
    operator(who);
    if (who.workspaceId && who.workspaceId !== input.workspaceId)
      throw new ReviewError(
        "scope_mismatch",
        "Review workspace does not match trusted context.",
        403,
      );
    validId(input.workspaceId);
    validId(input.worktreeId);
    boundedText(input.title, "title", 240);
    boundedText(input.focusPath, "path", 4096);
    target(input.target);
    return this.mutation(who, m, "createReview", input, () => {
      const reviewId = id("review"),
        time = now();
      this.database.run(
        "INSERT INTO reviews VALUES(?,?,?,?,?,?,?,1,?,?)",
        reviewId,
        who.ownerId,
        input.workspaceId,
        input.worktreeId,
        input.title,
        input.focusPath,
        JSON.stringify(input.target),
        time,
        time,
      );
      this.event(who, reviewId, "review.created", {});
      return { reviewId, version: 1 };
    });
  }
  createFromCapture(
    who: ReviewIdentity,
    input: { title: string; focusPath: string; target: LocalTarget },
    capture: SourceCapture,
    m: Mutation,
  ) {
    operator(who);
    return this.mutation(
      who,
      m,
      "createFromCapture",
      {
        ...input,
        workspaceId: capture.workspaceId,
        worktreeId: capture.worktreeId,
      },
      () => {
        const review = this.createReview(
          who,
          {
            ...input,
            workspaceId: capture.workspaceId,
            worktreeId: capture.worktreeId,
          },
          { requestId: m.requestId + "/review" },
        );
        const snapshot = this.capture(who, review.reviewId, capture, {
          requestId: m.requestId + "/snapshot",
        });
        return { ...review, ...snapshot };
      },
    );
  }
  listReviews(who: ReviewIdentity, limit?: number, after = "") {
    operator(who);
    return this.database.all<ReviewRecord>(
      "SELECT * FROM reviews WHERE owner_id=? AND (? IS NULL OR workspace_id=?) AND id>? ORDER BY id LIMIT ?",
      who.ownerId,
      who.workspaceId ?? null,
      who.workspaceId ?? null,
      after,
      pageSize(limit, LIMITS.threadPage),
    );
  }
  getReview(who: ReviewIdentity, reviewId: string) {
    operator(who);
    return this.own(who, reviewId);
  }
  setTarget(
    who: ReviewIdentity,
    reviewId: string,
    selected: LocalTarget,
    m: Mutation,
  ) {
    operator(who);
    this.own(who, reviewId);
    target(selected);
    return this.mutation(
      who,
      m,
      "setTarget",
      { reviewId, selected, version: m.expectedVersion },
      () => {
        const review = this.own(who, reviewId);
        version(review.version, m.expectedVersion);
        this.database.run(
          "UPDATE reviews SET target_json=?,version=version+1,updated_at=? WHERE id=?",
          JSON.stringify(selected),
          now(),
          reviewId,
        );
        this.event(who, reviewId, "review.target", { selected });
        return { reviewId, version: review.version + 1 };
      },
    );
  }
  capture(
    who: ReviewIdentity,
    reviewId: string,
    capture: SourceCapture,
    m: Mutation,
  ) {
    operator(who);
    const review = this.own(who, reviewId);
    if (
      review.workspace_id !== capture.workspaceId ||
      review.worktree_id !== capture.worktreeId
    )
      throw new ReviewError(
        "scope_mismatch",
        "Source does not belong to the review workspace/worktree.",
        409,
      );
    if (
      !["source", "staged", "unstaged", "commit"].includes(capture.mode) ||
      (capture.mode === "source" && !capture.files.length) ||
      capture.files.length > LIMITS.captureFiles
    )
      throw new ReviewError("limit", "Invalid or oversized source capture.");
    let bytes = 0;
    for (const file of capture.files) {
      for (const text of [file.oldText, file.newText])
        if (text !== null) {
          boundedText(text, "source", LIMITS.fileBytes, true);
          bytes += Buffer.byteLength(text);
          if (text.split("\n").length > LIMITS.fileLines)
            throw new ReviewError("limit", "Source exceeds line limit.");
        }
      for (const path of [file.oldPath, file.newPath])
        if (path !== null) boundedText(path, "path", 4096);
    }
    if (bytes > LIMITS.captureBytes)
      throw new ReviewError("limit", "Capture exceeds total byte limit.");
    return this.mutation(who, m, "capture", { reviewId, capture }, () => {
      const snapshotId = id("snapshot"),
        files: string[] = [];
      this.database.run(
        "INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)",
        snapshotId,
        reviewId,
        capture.mode,
        capture.base,
        capture.head,
        capture.capturedAt,
        hashText(stableJson(capture)),
      );
      for (const file of capture.files) {
        const hashes = [file.oldText, file.newText].map((text) => {
          if (text === null) return null;
          const hash = hashText(text);
          this.database.run(
            "INSERT OR IGNORE INTO blobs VALUES(?,?,?,?)",
            reviewId,
            hash,
            text,
            Buffer.byteLength(text),
          );
          return hash;
        });
        const fileId = id("file");
        files.push(fileId);
        this.database.run(
          "INSERT INTO snapshot_files VALUES(?,?,?,?,?,?,?,?,?)",
          fileId,
          snapshotId,
          reviewId,
          file.oldPath,
          file.newPath,
          file.change,
          hashes[0],
          hashes[1],
          file.fileIdentity ?? null,
        );
      }
      this.event(who, reviewId, "snapshot.created", { snapshotId, files });
      return { snapshotId, files };
    });
  }
  addFile(
    who: ReviewIdentity,
    reviewId: string,
    snapshotId: string,
    capture: SourceCapture,
    m: Mutation,
  ) {
    operator(who);
    this.own(who, reviewId);
    if (capture.mode !== "source" || capture.files.length !== 1)
      throw new ReviewError(
        "invalid_input",
        "Add file requires one saved source file.",
      );
    const snap = this.database.get<{ mode: string }>(
      "SELECT mode FROM snapshots WHERE id=? AND review_id=?",
      snapshotId,
      reviewId,
    );
    if (!snap) return this.missing();
    if (snap.mode !== "source")
      throw new ReviewError(
        "invalid_input",
        "Add file is available for saved-source reviews only.",
      );
    return this.mutation(
      who,
      m,
      "addFile",
      { reviewId, snapshotId, capture },
      () => {
        const previous = this.snapshotFiles(who, reviewId, snapshotId).map(
          (f) => {
            const full = this.readFile(who, reviewId, f.id);
            return {
              oldPath: full.old_path,
              newPath: full.new_path,
              oldText: full.oldText,
              newText: full.newText,
              change: "source" as const,
              fileIdentity: full.file_identity,
            };
          },
        );
        const path = capture.files[0]!.newPath;
        if (previous.some((f) => f.newPath === path))
          throw new ReviewError(
            "conflict",
            "File already belongs to this snapshot.",
            409,
          );
        return this.capture(
          who,
          reviewId,
          { ...capture, files: [...previous, ...capture.files] },
          { requestId: m.requestId + "/capture" },
        );
      },
    );
  }
  listSnapshots(who: ReviewIdentity, reviewId: string, limit?: number) {
    operator(who);
    this.own(who, reviewId);
    return this.database.all(
      "SELECT * FROM snapshots WHERE review_id=? ORDER BY captured_at DESC,id DESC LIMIT ?",
      reviewId,
      pageSize(limit, LIMITS.threadPage),
    );
  }
  snapshotFiles(who: ReviewIdentity, reviewId: string, snapshotId: string) {
    operator(who);
    this.own(who, reviewId);
    return this.database.all<SnapshotFileRecord>(
      "SELECT * FROM snapshot_files WHERE review_id=? AND snapshot_id=? ORDER BY COALESCE(new_path,old_path),id",
      reviewId,
      snapshotId,
    );
  }
  readFile(who: ReviewIdentity, reviewId: string, fileId: string) {
    operator(who);
    const file = this.file(who, reviewId, fileId);
    const read = (hash: string | null) =>
      hash
        ? (this.database.get<{ text: string }>(
            "SELECT text FROM blobs WHERE review_id=? AND hash=?",
            reviewId,
            hash,
          )?.text ?? null)
        : null;
    return {
      ...file,
      oldText: read(file.old_hash),
      newText: read(file.new_hash),
    };
  }
  private append(who: ReviewIdentity, thread: ThreadRecord, body: string) {
    const messageId = id("message"),
      time = now();
    const last = this.database.get<{ n: number }>(
      "SELECT COALESCE(MAX(ordinal),0) AS n FROM messages WHERE thread_id=?",
      thread.id,
    )!;
    this.database.run(
      "INSERT INTO messages VALUES(?,?,?,?,?,?,1,0,?,?)",
      messageId,
      thread.id,
      thread.review_id,
      last.n + 1,
      who.actorId,
      who.kind,
      time,
      time,
    );
    this.database.run(
      "INSERT INTO message_revisions VALUES(?,1,?,?)",
      messageId,
      body,
      time,
    );
    return messageId;
  }
  private advance(thread: ThreadRecord) {
    this.database.run(
      "UPDATE threads SET version=version+1,updated_at=? WHERE id=?",
      now(),
      thread.id,
    );
  }
  createThread(
    who: ReviewIdentity,
    reviewId: string,
    input: {
      fileId: string;
      side: "source" | "old" | "new";
      range?: { startLine: number; endLine: number };
      body: string;
    },
    m: Mutation,
  ) {
    operator(who);
    this.own(who, reviewId);
    boundedText(input.body, "comment");
    return this.mutation(who, m, "createThread", { reviewId, input }, () => {
      const review = this.own(who, reviewId),
        file = this.file(who, reviewId, input.fileId),
        anchor = createAnchor(
          file.id,
          input.side,
          this.source(file, input.side),
          input.range,
        );
      const threadId = id("thread"),
        time = now();
      this.database.run(
        "INSERT INTO threads VALUES(?,?,?,'open',?,1,1,?,?)",
        threadId,
        reviewId,
        JSON.stringify(anchor),
        review.target_json,
        time,
        time,
      );
      const thread = this.thread(who, threadId),
        messageId = this.append(who, thread, input.body);
      this.event(
        who,
        reviewId,
        "thread.created",
        { messageId, version: 1 },
        threadId,
      );
      return { threadId, messageId, version: 1 };
    });
  }
  listThreads(
    who: ReviewIdentity,
    reviewId: string,
    options: { state?: string; after?: string; limit?: number } = {},
  ) {
    this.own(who, reviewId);
    const rows = this.database.all<ThreadRecord>(
      "SELECT * FROM threads WHERE review_id=? AND state!='deleted' AND id>? AND (? IS NULL OR state=?) AND (?='operator' OR (json_extract(target_json,'$.chatId')=? AND json_extract(target_json,'$.incarnation')=?)) ORDER BY id LIMIT ?",
      reviewId,
      options.after ?? "",
      options.state ?? null,
      options.state ?? null,
      who.kind,
      who.chatId ?? "",
      who.chatIncarnation ?? "",
      pageSize(options.limit, LIMITS.threadPage),
    );
    return rows.map((row) => ({
      ...row,
      anchor: JSON.parse(row.anchor_json),
      target: JSON.parse(row.target_json),
    }));
  }
  getThread(who: ReviewIdentity, threadId: string, after = 0, limit?: number) {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new ReviewError("invalid_input", "Invalid message cursor.");
    const thread = this.thread(who, threadId),
      anchor = JSON.parse(thread.anchor_json) as OriginalAnchor;
    const messages = this.database.all<MessageRecord & { body: string | null }>(
      "SELECT m.*,r.body FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.version=m.version WHERE m.thread_id=? AND m.ordinal>? ORDER BY m.ordinal LIMIT ?",
      thread.id,
      after,
      pageSize(limit, LIMITS.historyPage),
    );
    const file = this.file(who, thread.review_id, anchor.snapshotFileId);
    return {
      ...thread,
      anchor,
      target: JSON.parse(thread.target_json),
      messages,
      source: {
        fileId: file.id,
        snapshotId: file.snapshot_id,
        oldPath: file.old_path,
        newPath: file.new_path,
        blobSha256: anchor.blobSha256,
        fileIdentity: file.file_identity,
        selectedText: anchor.selectedText,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
      },
    };
  }
  reply(
    who: ReviewIdentity,
    threadId: string,
    body: string,
    m: Mutation,
    assignmentEpoch?: number,
    reopen = false,
  ) {
    this.thread(who, threadId);
    boundedText(body, "reply");
    return this.mutation(
      who,
      m,
      "reply",
      { threadId, body, version: m.expectedVersion, assignmentEpoch, reopen },
      () => {
        const thread = this.thread(who, threadId);
        version(thread.version, m.expectedVersion);
        this.epoch(who, thread, assignmentEpoch);
        if (thread.state === "resolved") {
          if (!reopen || who.kind !== "operator")
            throw new ReviewError(
              "resolved",
              "Explicit reopen-and-post required.",
              409,
            );
          this.database.run(
            "UPDATE threads SET state='open' WHERE id=?",
            threadId,
          );
          this.event(who, thread.review_id, "thread.reopened", {}, threadId);
        }
        const messageId = this.append(who, thread, body);
        this.advance(thread);
        this.event(
          who,
          thread.review_id,
          "message.created",
          { messageId, version: thread.version + 1 },
          threadId,
        );
        return { threadId, messageId, version: thread.version + 1 };
      },
    );
  }
  editMessage(
    who: ReviewIdentity,
    messageId: string,
    body: string | null,
    m: Mutation,
    assignmentEpoch?: number,
  ) {
    const message = this.database.get<MessageRecord>(
      "SELECT * FROM messages WHERE id=?",
      messageId,
    );
    if (!message) return this.missing();
    this.thread(who, message.thread_id, true);
    if (message.author_id !== who.actorId || message.author_kind !== who.kind)
      throw new ReviewError(
        "forbidden",
        "Only the message author can change it.",
        403,
      );
    if (body !== null) boundedText(body, "comment");
    return this.mutation(
      who,
      m,
      body === null ? "deleteMessage" : "editMessage",
      { messageId, body, version: m.expectedVersion, assignmentEpoch },
      () => {
        const current = this.database.get<MessageRecord>(
          "SELECT * FROM messages WHERE id=?",
          messageId,
        )!;
        const thread = this.thread(who, current.thread_id);
        this.epoch(who, thread, assignmentEpoch);
        version(current.version, m.expectedVersion);
        if (current.deleted)
          throw new ReviewError("deleted", "Message was deleted.", 409);
        if (body === null)
          this.database.run(
            "UPDATE message_revisions SET body=NULL WHERE message_id=?",
            messageId,
          );
        this.database.run(
          "INSERT INTO message_revisions VALUES(?,?,?,?)",
          messageId,
          current.version + 1,
          body,
          now(),
        );
        this.database.run(
          "UPDATE messages SET version=version+1,deleted=?,updated_at=? WHERE id=?",
          body === null ? 1 : 0,
          now(),
          messageId,
        );
        this.advance(thread);
        this.event(
          who,
          thread.review_id,
          body === null ? "message.deleted" : "message.edited",
          { messageId, version: current.version + 1 },
          thread.id,
        );
        return {
          messageId,
          version: current.version + 1,
          threadVersion: thread.version + 1,
        };
      },
    );
  }
  resolveThread(
    who: ReviewIdentity,
    threadId: string,
    input: {
      explanation: string;
      evidence?: string[];
      fileId: string;
      assignmentEpoch?: number;
    },
    m: Mutation,
  ) {
    this.thread(who, threadId);
    boundedText(input.explanation, "resolution explanation");
    if (
      input.evidence &&
      (input.evidence.length > 10 ||
        input.evidence.some(
          (s) =>
            typeof s !== "string" ||
            s.length > 2048 ||
            /^(?:javascript|data):/i.test(s),
        ))
    )
      throw new ReviewError("invalid_input", "Invalid evidence references.");
    return this.mutation(
      who,
      m,
      "resolve",
      { threadId, input, version: m.expectedVersion },
      () => {
        const thread = this.thread(who, threadId);
        version(thread.version, m.expectedVersion);
        this.epoch(who, thread, input.assignmentEpoch);
        this.file(who, thread.review_id, input.fileId);
        const projection = this.project(who, threadId, input.fileId);
        if (!["exact", "moved"].includes(projection.status))
          throw new ReviewError(
            "stale_source",
            "Resolution requires a verified source mapping; inspect or explicitly re-anchor first.",
            409,
          );
        if (thread.state !== "open")
          throw new ReviewError("resolved", "Thread is already resolved.", 409);
        const messageId = this.append(who, thread, input.explanation);
        this.database.run(
          "UPDATE threads SET state='resolved',version=version+1,updated_at=? WHERE id=?",
          now(),
          threadId,
        );
        this.event(
          who,
          thread.review_id,
          "thread.resolved",
          {
            messageId,
            fileId: input.fileId,
            evidence: input.evidence ?? [],
            addressedVersion: thread.version,
          },
          threadId,
        );
        return { threadId, messageId, version: thread.version + 1 };
      },
    );
  }
  reopen(who: ReviewIdentity, threadId: string, m: Mutation) {
    operator(who);
    this.thread(who, threadId);
    return this.mutation(
      who,
      m,
      "reopen",
      { threadId, version: m.expectedVersion },
      () => {
        const thread = this.thread(who, threadId);
        version(thread.version, m.expectedVersion);
        if (thread.state !== "resolved")
          throw new ReviewError(
            "conflict",
            "Only resolved threads can be reopened.",
            409,
          );
        this.database.run(
          "UPDATE threads SET state='open',version=version+1,updated_at=? WHERE id=?",
          now(),
          threadId,
        );
        this.event(who, thread.review_id, "thread.reopened", {}, threadId);
        return { threadId, version: thread.version + 1 };
      },
    );
  }
  reassign(
    who: ReviewIdentity,
    threadId: string,
    selected: LocalTarget,
    m: Mutation,
  ) {
    operator(who);
    this.thread(who, threadId);
    target(selected);
    return this.mutation(
      who,
      m,
      "reassign",
      { threadId, selected, version: m.expectedVersion },
      () => {
        const thread = this.thread(who, threadId);
        version(thread.version, m.expectedVersion);
        this.database.run(
          "UPDATE threads SET target_json=?,assignment_epoch=assignment_epoch+1,version=version+1,updated_at=? WHERE id=?",
          JSON.stringify(selected),
          now(),
          threadId,
        );
        this.event(
          who,
          thread.review_id,
          "thread.reassigned",
          { target: selected, epoch: thread.assignment_epoch + 1 },
          threadId,
        );
        return {
          threadId,
          version: thread.version + 1,
          assignmentEpoch: thread.assignment_epoch + 1,
        };
      },
    );
  }
  deleteThread(who: ReviewIdentity, threadId: string, m: Mutation) {
    operator(who);
    this.thread(who, threadId, true);
    return this.mutation(
      who,
      m,
      "deleteThread",
      { threadId, version: m.expectedVersion },
      () => {
        const thread = this.thread(who, threadId);
        version(thread.version, m.expectedVersion);
        this.database.run(
          "UPDATE message_revisions SET body=NULL WHERE message_id IN (SELECT id FROM messages WHERE thread_id=?)",
          threadId,
        );
        this.database.run(
          "UPDATE messages SET deleted=1 WHERE thread_id=?",
          threadId,
        );
        this.database.run("DELETE FROM drafts WHERE thread_id=?", threadId);
        this.database.run(
          "UPDATE threads SET state='deleted',version=version+1,updated_at=? WHERE id=?",
          now(),
          threadId,
        );
        this.event(
          who,
          thread.review_id,
          "thread.deleted",
          { version: thread.version + 1 },
          threadId,
        );
        return { threadId, version: thread.version + 1 };
      },
    );
  }
  saveDraft(
    who: ReviewIdentity,
    reviewId: string,
    input: {
      id?: string;
      threadId?: string;
      anchor?: OriginalAnchor;
      body: string;
    },
    m: Mutation,
  ) {
    operator(who);
    this.own(who, reviewId);
    boundedText(input.body, "draft", LIMITS.commentBytes, true);
    return this.mutation(
      who,
      m,
      "saveDraft",
      { reviewId, input, version: m.expectedVersion },
      () => {
        if (input.threadId) {
          const t = this.thread(who, input.threadId);
          if (t.review_id !== reviewId) this.missing();
        } else if (input.anchor) {
          const f = this.file(who, reviewId, input.anchor.snapshotFileId);
          const checked = createAnchor(
            f.id,
            input.anchor.side,
            this.source(f, input.anchor.side),
            input.anchor.scope === "file"
              ? undefined
              : {
                  startLine: input.anchor.startLine!,
                  endLine: input.anchor.endLine!,
                },
          );
          if (stableJson(checked) !== stableJson(input.anchor))
            throw new ReviewError(
              "invalid_anchor",
              "Draft anchor must match source.",
            );
        } else
          throw new ReviewError(
            "invalid_anchor",
            "Draft requires a thread or source anchor.",
          );
        const draftId = input.id ?? id("draft"),
          old = this.database.get<{
            version: number;
            owner_id: string;
            review_id: string;
          }>("SELECT * FROM drafts WHERE id=?", draftId);
        if (old) {
          if (old.owner_id !== who.ownerId || old.review_id !== reviewId)
            this.missing();
          version(old.version, m.expectedVersion);
        } else if (
          input.id ||
          (m.expectedVersion !== undefined && m.expectedVersion !== 0)
        )
          this.missing();
        if (old) {
          const binding = this.database.get<{
            thread_id: string | null;
            anchor_json: string | null;
          }>("SELECT thread_id,anchor_json FROM drafts WHERE id=?", draftId)!;
          if (
            binding.thread_id !== (input.threadId ?? null) ||
            binding.anchor_json !==
              (input.anchor ? JSON.stringify(input.anchor) : null)
          )
            throw new ReviewError(
              "conflict",
              "Draft anchor and reply target cannot silently change.",
              409,
            );
        }
        this.database.run(
          "INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,version=excluded.version,updated_at=excluded.updated_at",
          draftId,
          who.ownerId,
          reviewId,
          input.threadId ?? null,
          input.anchor ? JSON.stringify(input.anchor) : null,
          input.body,
          (old?.version ?? 0) + 1,
          now(),
        );
        return { draftId, version: (old?.version ?? 0) + 1 };
      },
    );
  }
  listDrafts(who: ReviewIdentity, reviewId: string) {
    operator(who);
    this.own(who, reviewId);
    return this.database.all(
      "SELECT * FROM drafts WHERE owner_id=? AND review_id=? ORDER BY updated_at DESC LIMIT ?",
      who.ownerId,
      reviewId,
      LIMITS.historyPage,
    );
  }
  makeAnchor(
    who: ReviewIdentity,
    reviewId: string,
    fileId: string,
    side: "source" | "old" | "new",
    range?: { startLine: number; endLine: number },
  ) {
    operator(who);
    const file = this.file(who, reviewId, fileId);
    return createAnchor(file.id, side, this.source(file, side), range);
  }
  deleteDraft(
    who: ReviewIdentity,
    reviewId: string,
    draftId: string,
    m: Mutation,
  ) {
    operator(who);
    this.own(who, reviewId);
    return this.mutation(
      who,
      m,
      "deleteDraft",
      { reviewId, draftId, version: m.expectedVersion },
      () => {
        const draft = this.database.get<{ version: number }>(
          "SELECT version FROM drafts WHERE id=? AND review_id=? AND owner_id=?",
          draftId,
          reviewId,
          who.ownerId,
        );
        if (!draft) return this.missing();
        version(draft.version, m.expectedVersion);
        this.database.run("DELETE FROM drafts WHERE id=?", draftId);
        return { draftId, deleted: true };
      },
    );
  }
  project(who: ReviewIdentity, threadId: string, fileId: string) {
    const thread = this.thread(who, threadId),
      anchor = JSON.parse(thread.anchor_json) as OriginalAnchor;
    const previous = this.file(who, thread.review_id, anchor.snapshotFileId),
      current = this.file(who, thread.review_id, fileId);
    const manual = this.database.get<{ projection_json: string }>(
      "SELECT projection_json FROM projections WHERE thread_id=? AND snapshot_file_id=?",
      threadId,
      fileId,
    );
    if (manual) return JSON.parse(manual.projection_json);
    const samePath =
      (previous.new_path || previous.old_path) ===
      (current.new_path || current.old_path);
    const rename =
      current.change_kind === "renamed" &&
      current.old_path === (previous.new_path || previous.old_path) &&
      previous.new_hash !== null &&
      current.old_hash === previous.new_hash;
    const sameFile =
      previous.id === current.id ||
      rename ||
      (samePath &&
        previous.file_identity != null &&
        current.file_identity != null &&
        previous.file_identity === current.file_identity);
    let text: string;
    try {
      const side = anchor.side === "source" && current.change_kind !== "source" && current.change_kind !== "unchanged" ? "new" : anchor.side;
      text = this.source(current, side);
    } catch {
      return {
        status: "missing",
        startLine: null,
        endLine: null,
        method: "unmapped",
      };
    }
    const projection = projectAnchor(anchor, text, { sameFile });
    return { ...projection, side: anchor.side === "source" && current.change_kind !== "source" && current.change_kind !== "unchanged" ? "new" : anchor.side };
  }
  reanchor(
    who: ReviewIdentity,
    threadId: string,
    input: {
      fileId: string;
      side: "source" | "old" | "new";
      range?: { startLine: number; endLine: number };
      reopen?: boolean;
    },
    m: Mutation,
  ) {
    operator(who);
    this.thread(who, threadId);
    return this.mutation(
      who,
      m,
      "reanchor",
      { threadId, input, version: m.expectedVersion },
      () => {
        const thread = this.thread(who, threadId);
        version(thread.version, m.expectedVersion);
        if (thread.state === "resolved" && !input.reopen)
          throw new ReviewError(
            "resolved",
            "Confirm reopen-and-re-anchor first.",
            409,
          );
        const file = this.file(who, thread.review_id, input.fileId),
          anchor = createAnchor(
            file.id,
            input.side,
            this.source(file, input.side),
            input.range,
          );
        const projection = {
          status: "moved",
          startLine: anchor.startLine,
          endLine: anchor.endLine,
          method: "manual",
          side: anchor.side,
          scope: anchor.scope,
        };
        this.database.run(
          "INSERT INTO projections VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,snapshot_file_id) DO UPDATE SET projection_json=excluded.projection_json,actor_id=excluded.actor_id,created_at=excluded.created_at",
          threadId,
          thread.review_id,
          file.id,
          JSON.stringify(projection),
          who.actorId,
          now(),
        );
        this.database.run(
          "UPDATE threads SET state='open',version=version+1,updated_at=? WHERE id=?",
          now(),
          threadId,
        );
        this.event(
          who,
          thread.review_id,
          "thread.reanchored",
          {
            fileId: file.id,
            projection,
            reopened: thread.state === "resolved",
          },
          threadId,
        );
        return { threadId, version: thread.version + 1 };
      },
    );
  }
  events(who: ReviewIdentity, reviewId: string, after = 0, limit?: number) {
    operator(who);
    this.own(who, reviewId);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new ReviewError("invalid_input", "Invalid event cursor.");
    return this.database.all(
      "SELECT * FROM events WHERE review_id=? AND cursor>? ORDER BY cursor LIMIT ?",
      reviewId,
      after,
      pageSize(limit, LIMITS.historyPage),
    );
  }
}
