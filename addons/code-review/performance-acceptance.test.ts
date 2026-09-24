import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LIMITS, type SourceCapture } from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { compareSource, highlightSource, sourceLines } from "./render-source.js";
import { reviewAction } from "./runtime.js";
import { SourceReader } from "./source.js";

function workspaceFixture(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    write(path: string, text: string | Uint8Array) {
      writeFileSync(join(dir, path), text);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function gitFixture() {
  const workspace = workspaceFixture("review-performance-git-");
  const env = {
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: workspace.dir,
      env,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.autocrlf", "false");
  return {
    ...workspace,
    env,
    git,
    reader: new SourceReader(workspace.dir),
  };
}

function runtimeFixture(path: string, text: string) {
  const dir = mkdtempSync(join(tmpdir(), "review-performance-runtime-"));
  writeFileSync(join(dir, path), text);
  const service = new ReviewService(join(dir, "review.db"));
  const who = {
    ownerId: "owner",
    actorId: "human",
    kind: "operator" as const,
    workspaceId: "workspace-1",
  };
  const target = {
    chatId: "web:worker",
    incarnation: "branch1",
    label: "Worker",
  };
  const hostTarget = {
    chatJid: target.chatId,
    incarnation: target.incarnation,
    label: target.label,
    agentName: "worker",
    active: false,
  };
  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: who.ownerId,
    actorId: who.actorId,
    kind: "operator",
    workspaceRoot: dir,
    workspaceId: who.workspaceId,
    async listTargets() {
      return [hostTarget];
    },
    async resolveTarget(input) {
      return (!input.incarnation || input.incarnation === hostTarget.incarnation) &&
          (input.chatJid === hostTarget.chatJid || input.agentName === hostTarget.agentName)
        ? hostTarget
        : null;
    },
    async enqueue() {
      return { status: "accepted", rowId: 1 };
    },
  };
  return {
    dir,
    service,
    who,
    target,
    ctx,
    cleanup() {
      service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function htmlAt(lines: Array<{ number: number; html: string }>, number: number) {
  return lines.find((line) => line.number === number)?.html ?? "";
}

test("CR-083 source byte and line limits are enforced at the true boundary", async () => {
  const f = workspaceFixture("review-performance-source-");
  const reader = new SourceReader(f.dir);
  const twoByte = "é";
  const exactBytes = twoByte.repeat(LIMITS.fileBytes / Buffer.byteLength(twoByte));
  const exactLines = Array.from(
    { length: LIMITS.fileLines },
    (_, index) => `line ${index + 1}`,
  ).join("\n");
  try {
    f.write("exact-bytes.ts", exactBytes);
    const byBytes = await reader.capture({ path: "exact-bytes.ts", mode: "source" });
    expect(Buffer.byteLength(byBytes.files[0]!.newText!)).toBe(LIMITS.fileBytes);

    f.write(
      "too-many-bytes.ts",
      twoByte.repeat(LIMITS.fileBytes / Buffer.byteLength(twoByte) + 1),
    );
    await expect(
      reader.capture({ path: "too-many-bytes.ts", mode: "source" }),
    ).rejects.toThrow("byte limit");

    f.write("exact-lines.ts", exactLines);
    const byLines = await reader.capture({ path: "exact-lines.ts", mode: "source" });
    expect(sourceLines(byLines.files[0]!.newText!)).toHaveLength(LIMITS.fileLines);

    f.write("too-many-lines.ts", `${exactLines}\nline ${LIMITS.fileLines + 1}`);
    await expect(
      reader.capture({ path: "too-many-lines.ts", mode: "source" }),
    ).rejects.toThrow("line limit");
  } finally {
    f.cleanup();
  }
});

test("CR-083 comment submission enforces the documented UTF-8 byte limit without truncation", async () => {
  const f = runtimeFixture("comments.ts", "const ready = true;\n");
  const exactComment = "é".repeat(LIMITS.commentBytes / Buffer.byteLength("é"));
  try {
    const created = await reviewAction(
      f.ctx,
      "create",
      { path: "comments.ts", target: { agentName: "worker" }, requestId: "create-comment-limit" },
      f.service,
    ) as { reviewId: string; files: string[] };

    const thread = await reviewAction(
      f.ctx,
      "comment",
      {
        reviewId: created.reviewId,
        fileId: created.files[0],
        side: "source",
        range: { startLine: 1, endLine: 1 },
        body: exactComment,
        requestId: "comment-exact-limit",
      },
      f.service,
    ) as { threadId: string };

    const stored = await reviewAction(
      f.ctx,
      "thread",
      { threadId: thread.threadId },
      f.service,
    ) as { messages: Array<{ body: string | null }> };
    expect(stored.messages[0]?.body).toBe(exactComment);

    await expect(
      reviewAction(
        f.ctx,
        "comment",
        {
          reviewId: created.reviewId,
          fileId: created.files[0],
          side: "source",
          range: { startLine: 1, endLine: 1 },
          body: "é".repeat(LIMITS.commentBytes / Buffer.byteLength("é") + 1),
          requestId: "comment-over-limit",
        },
        f.service,
      ),
    ).rejects.toThrow(`at most ${LIMITS.commentBytes} UTF-8 bytes`);
  } finally {
    f.cleanup();
  }
});

test("CR-083/089 diff work fails with explicit computation-budget and changed-line limit states", async () => {
  const repeated = Math.floor(LIMITS.diffLines / 2) + 1;
  expect(() => compareSource("a\n".repeat(repeated), "b\n".repeat(repeated))).toThrow(
    "Diff exceeds computation budget.",
  );

  const f = gitFixture();
  const changedPerFile = Math.floor(LIMITS.diffLines / 3) + 1;
  try {
    for (const name of ["a.ts", "b.ts", "c.ts"]) f.write(name, "base\n");
    f.git("add", ".");
    f.git("commit", "-qm", "base");

    for (const name of ["a.ts", "b.ts", "c.ts"])
      f.write(name, "changed\n".repeat(changedPerFile));

    await expect(f.reader.capture({ path: ".", mode: "unstaged" })).rejects.toThrow(
      "changed-line limit",
    );
  } finally {
    f.cleanup();
  }
});

test("CR-121 oversized or unsupported syntax falls back to escaped plain text", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const unsupported = highlightSource("fixture.rust", hostile);
  expect(unsupported).toMatchObject({ highlighted: false, language: "text" });
  expect(unsupported.lines[0]?.html).toBe("&lt;img src=x onerror=alert(1)&gt;");

  const oversized = highlightSource(
    "fixture.ts",
    Array.from({ length: 2501 }, () => hostile).join("\n"),
  );
  expect(oversized.highlighted).toBe(false);
  expect(oversized.language).toBe("typescript");
  expect(oversized.lines[0]?.html).toBe("&lt;img src=x onerror=alert(1)&gt;");
  expect(oversized.lines.some((line) => line.html.includes("<span"))).toBe(false);
});

test("CR-089 file pages stay bounded under long permitted source via the real action adapter", async () => {
  const longSource = Array.from(
    { length: 3000 },
    (_, index) => `<row ${index + 1}>`,
  ).join("\n");
  const f = runtimeFixture("long.ts", longSource);
  try {
    const created = await reviewAction(
      f.ctx,
      "create",
      { path: "long.ts", target: { agentName: "worker" }, requestId: "create-long-source" },
      f.service,
    ) as { reviewId: string; files: string[] };

    const page = await reviewAction(
      f.ctx,
      "file",
      { reviewId: created.reviewId, fileId: created.files[0], offset: 2500, limit: 25 },
      f.service,
    ) as {
      change_kind: string;
      offset: number;
      limit: number;
      diff: null;
      new: {
        highlighted: boolean;
        total: number;
        lines: Array<{ number: number; text: string; html: string }>;
      };
    };

    expect(page.change_kind).toBe("source");
    expect(page.offset).toBe(2500);
    expect(page.limit).toBe(25);
    expect(page.diff).toBeNull();
    expect(page.new.highlighted).toBe(false);
    expect(page.new.total).toBe(3000);
    expect(page.new.lines).toHaveLength(25);
    expect(page.new.lines[0]).toMatchObject({ number: 2501, text: "<row 2501>" });
    expect(page.new.lines[0]?.html).toBe("&lt;row 2501&gt;");
    expect(page.new.lines.at(-1)).toMatchObject({ number: 2525, text: "<row 2525>" });
  } finally {
    f.cleanup();
  }
});

test("CR-119 diff pages highlight each snapshot independently before slicing", async () => {
  const f = runtimeFixture("placeholder.ts", "const placeholder = true;\n");
  const oldText =
    "const before = 1;\n/* first\n * const still comment\n */\nconst after = 2;\n";
  const newText =
    "const before = 1;\nconst stillComment = 2;\nconst template = `first\nsecond`;\nconst after = 2;\n";
  try {
    const capture: SourceCapture = {
      workspaceId: f.who.workspaceId,
      worktreeId: "worktree-1",
      mode: "staged",
      base: "base",
      head: "head",
      capturedAt: new Date().toISOString(),
      files: [
        {
          oldPath: "sample.ts",
          newPath: "sample.ts",
          change: "modified",
          oldText,
          newText,
          fileIdentity: null,
        },
      ],
    };
    const review = f.service.createFromCapture(
      f.who,
      { title: "Diff review", focusPath: "sample.ts", target: f.target },
      capture,
      { requestId: "create-diff-review" },
    );

    const page = await reviewAction(
      f.ctx,
      "file",
      { reviewId: review.reviewId, fileId: review.files[0], offset: 0, limit: 10 },
      f.service,
    ) as {
      diffTotal: number;
      old: { highlighted: boolean; total: number; lines: Array<{ number: number; html: string }> };
      new: { highlighted: boolean; total: number; lines: Array<{ number: number; html: string }> };
    };

    expect(page.diffTotal).toBe(8);
    expect(page.old.highlighted).toBe(true);
    expect(page.new.highlighted).toBe(true);
    expect(page.old.total).toBe(5);
    expect(page.new.total).toBe(5);
    expect(htmlAt(page.old.lines, 2)).toContain("tok-comment");
    expect(htmlAt(page.new.lines, 2)).not.toContain("tok-comment");
    expect(htmlAt(page.new.lines, 3)).toContain("tok-string2");
  } finally {
    f.cleanup();
  }
});
