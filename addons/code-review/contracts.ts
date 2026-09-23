/** Shared durable contracts. Host supplies identity; client IDs never confer authority. */
export type ReviewIdentity = Readonly<{
  ownerId: string;
  actorId: string;
  kind: "operator" | "agent";
  workspaceId?: string;
  chatId?: string;
  chatIncarnation?: string;
}>;
export type LocalTarget = Readonly<{
  chatId: string;
  incarnation: string;
  label: string;
}>;
export type SourceMode = "source" | "unstaged" | "staged" | "commit";
export type AnchorSide = "source" | "old" | "new";
export type ThreadState = "open" | "resolved" | "deleted";
export type WorkState =
  | "not_started"
  | "in_progress"
  | "waiting_user"
  | "blocked"
  | "failed"
  | "completed"
  | "superseded";
export type DeliveryState =
  | "prepared"
  | "attempting"
  | "accepted"
  | "rejected"
  | "unknown";
export interface SourceCapture {
  workspaceId: string;
  worktreeId: string;
  mode: SourceMode;
  base: string | null;
  head: string | null;
  capturedAt: string;
  files: CaptureFile[];
}
export interface CaptureFile {
  oldPath: string | null;
  newPath: string | null;
  change: "source" | "added" | "modified" | "deleted" | "renamed" | "unchanged";
  oldText: string | null;
  newText: string | null;
  /** Filesystem incarnation for saved worktrees; null for immutable Git sides. */
  fileIdentity?: string | null;
}
export interface OriginalAnchor {
  snapshotFileId: string;
  scope: "file" | "range";
  side: AnchorSide;
  startLine: number | null;
  endLine: number | null;
  blobSha256: string;
  selectedText: string;
  contextBefore: string[];
  contextAfter: string[];
}
export interface AnchorProjection {
  status: "exact" | "moved" | "ambiguous" | "missing";
  startLine: number | null;
  endLine: number | null;
  method: "same-snapshot" | "unique-context" | "manual" | "unmapped";
}
export interface Mutation {
  requestId: string;
  expectedVersion?: number;
}
export interface ReviewErrorShape {
  code: string;
  message: string;
  status: number;
}
export class ReviewError extends Error implements ReviewErrorShape {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}
export const LIMITS = Object.freeze({
  fileBytes: 2 * 1024 * 1024,
  fileLines: 50_000,
  diffLines: 10_000,
  commentBytes: 16 * 1024,
  historyPage: 100,
  threadPage: 50,
  captureFiles: 100,
  captureBytes: 8 * 1024 * 1024,
  batchItems: 50,
  contextLines: 3,
});
