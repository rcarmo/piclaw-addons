import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "./dispatch.js";
import type { ReviewIdentity, SourceCapture } from "./contracts.js";
test("CR-058/063/103/169 manual projections never rewrite source and replay cannot skip a new thread version", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-navigation-"));
  const service = new ReviewService(join(dir, "db"));
  const who: ReviewIdentity = {
    ownerId: "o1",
    actorId: "h1",
    kind: "operator",
  };
  let n = 0;
  const m = (v?: number) => ({ requestId: "r" + ++n, expectedVersion: v });
  try {
    const r = service.createReview(
      who,
      {
        workspaceId: "w1",
        worktreeId: "t1",
        title: "review",
        focusPath: "a.ts",
        target: { chatId: "web:a", incarnation: "b1", label: "A" },
      },
      m(),
    );
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
          oldText: null,
          newText: "a\nb\nc\n",
          change: "source",
          fileIdentity: "i1",
        },
      ],
    };
    const a = service.capture(who, r.reviewId, cap, m()).files[0]!;
    const t = service.createThread(
      who,
      r.reviewId,
      {
        fileId: a,
        side: "source",
        range: { startLine: 2, endLine: 2 },
        body: "B",
      },
      m(),
    );
    const b = service.capture(
      who,
      r.reviewId,
      { ...cap, files: [{ ...cap.files[0]!, newText: "x\ny\nz\n" }] },
      m(),
    ).files[0]!;
    const old = service.getThread(who, t.threadId);
    service.reanchor(
      who,
      t.threadId,
      { fileId: b, side: "source", range: { startLine: 3, endLine: 3 } },
      m(1),
    );
    expect(service.getThread(who, t.threadId).anchor).toEqual(old.anchor);
    expect(service.project(who, t.threadId, b)).toMatchObject({
      method: "manual",
      startLine: 3,
    });
    expect(service.readFile(who, r.reviewId, a).newText).toBe("a\nb\nc\n");
    expect(() =>
      service.resolveThread(
        who,
        t.threadId,
        { fileId: b, explanation: "done" },
        m(1),
      ),
    ).toThrow("record changed");
    service.resolveThread(
      who,
      t.threadId,
      { fileId: b, explanation: "done" },
      m(2),
    );
    expect(service.getThread(who, t.threadId).state).toBe("resolved");
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
