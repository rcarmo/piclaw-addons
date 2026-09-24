import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReviewIdentity, SourceCapture } from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import { SourceReader } from "./source.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-git-rename-accept-"));
  const repoDir = join(root, "repo");
  const storeDir = join(root, "store");
  mkdirSync(repoDir);
  mkdirSync(storeDir);

  const env = {
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repoDir,
      env,
      encoding: "utf8",
    }).trim();

  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.autocrlf", "false");

  const store = new ReviewService(join(storeDir, "review.db"));
  let serial = 0;

  return {
    repoDir,
    store,
    reader: new SourceReader(repoDir),
    git,
    mutation(expectedVersion?: number) {
      return {
        requestId: `git-rename-${++serial}`,
        expectedVersion,
      };
    },
    write(path: string, text: string | Uint8Array) {
      const full = join(repoDir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, text);
    },
    cleanup() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function operator(workspaceId: string): ReviewIdentity {
  return {
    ownerId: "one",
    actorId: "operator",
    kind: "operator",
    workspaceId,
  };
}

async function reviewFixture() {
  const f = fixture();
  const text = "before\nstart\nconcern\nend\nafter\n";
  f.write("src/main.ts", text);
  const sourceBytes = readFileSync(join(f.repoDir, "src/main.ts"));
  f.git("add", ".");
  f.git("commit", "-qm", "base");

  const sourceCapture = await f.reader.capture({
    path: "src/main.ts",
    mode: "source",
  });
  const who = operator(sourceCapture.workspaceId);
  const reviewId = f.store.createReview(
    who,
    {
      workspaceId: sourceCapture.workspaceId,
      worktreeId: sourceCapture.worktreeId,
      title: "CR-059 rename review",
      focusPath: "src/main.ts",
      target: { chatId: "web:a", incarnation: "b1", label: "A" },
    },
    f.mutation(),
  ).reviewId;
  const sourceFileId = f.store.capture(
    who,
    reviewId,
    sourceCapture,
    f.mutation(),
  ).files[0]!;
  const thread = f.store.createThread(
    who,
    reviewId,
    {
      fileId: sourceFileId,
      side: "source",
      range: { startLine: 3, endLine: 3 },
      body: "Handle concern",
    },
    f.mutation(),
  );

  return {
    ...f,
    who,
    reviewId,
    sourceFileId,
    sourceCapture,
    sourceBytes,
    text,
    thread,
  };
}

test("CR-059 real staged git mv projects to the renamed new side without mutating Git", async () => {
  const f = await reviewFixture();
  try {
    const originalThread = f.store.getThread(f.who, f.thread.threadId);
    const originalFile = f.store.readFile(f.who, f.reviewId, f.sourceFileId);

    expect(f.sourceCapture.files).toHaveLength(1);
    expect(f.sourceCapture.files[0]).toMatchObject({
      oldPath: null,
      newPath: "src/main.ts",
      change: "source",
      oldText: null,
      newText: f.text,
    });
    expect(f.sourceCapture.files[0]?.fileIdentity).toBeTruthy();
    expect(originalFile).toMatchObject({
      old_path: null,
      new_path: "src/main.ts",
      change_kind: "source",
      oldText: null,
      newText: f.text,
    });

    f.git("mv", "src/main.ts", "src/entry.ts");
    expect(readFileSync(join(f.repoDir, "src/entry.ts")).equals(f.sourceBytes)).toBe(
      true,
    );

    const statusBeforeCapture = f.git("status", "--porcelain=v1");
    const indexBeforeCapture = readFileSync(join(f.repoDir, ".git/index"));
    const stagedCapture = await f.reader.capture({ path: ".", mode: "staged" });

    expect(f.git("status", "--porcelain=v1")).toBe(statusBeforeCapture);
    expect(readFileSync(join(f.repoDir, ".git/index")).equals(indexBeforeCapture)).toBe(
      true,
    );
    expect(stagedCapture.workspaceId).toBe(f.sourceCapture.workspaceId);
    expect(stagedCapture.worktreeId).toBe(f.sourceCapture.worktreeId);
    expect(stagedCapture.files).toHaveLength(1);
    expect(stagedCapture.files[0]).toMatchObject({
      oldPath: "src/main.ts",
      newPath: "src/entry.ts",
      change: "renamed",
      oldText: f.text,
      newText: f.text,
      fileIdentity: null,
    });

    const renamedFileId = f.store.capture(
      f.who,
      f.reviewId,
      stagedCapture,
      f.mutation(),
    ).files[0]!;
    const renamedFile = f.store.readFile(f.who, f.reviewId, renamedFileId);

    expect(renamedFile).toMatchObject({
      old_path: "src/main.ts",
      new_path: "src/entry.ts",
      change_kind: "renamed",
      oldText: f.text,
      newText: f.text,
      file_identity: null,
    });

    expect(f.store.project(f.who, f.thread.threadId, renamedFileId)).toMatchObject(
      {
        status: "exact",
        startLine: 3,
        endLine: 3,
        side: "new",
      },
    );
    expect(f.store.getThread(f.who, f.thread.threadId)).toMatchObject({
      state: "open",
      anchor: originalThread.anchor,
      source: {
        fileId: f.sourceFileId,
        oldPath: null,
        newPath: "src/main.ts",
        blobSha256: originalThread.source.blobSha256,
        fileIdentity: originalThread.source.fileIdentity,
      },
    });
  } finally {
    f.cleanup();
  }
});

test("CR-059 fake rename with a changed old blob cannot project", async () => {
  const f = await reviewFixture();
  try {
    const fake: SourceCapture = {
      workspaceId: f.sourceCapture.workspaceId,
      worktreeId: f.sourceCapture.worktreeId,
      mode: "staged",
      base: "commit1",
      head: "index1",
      capturedAt: new Date().toISOString(),
      files: [
        {
          oldPath: "src/main.ts",
          newPath: "src/entry.ts",
          change: "renamed",
          oldText: `${f.text}plus\n`,
          newText: f.text,
          fileIdentity: null,
        },
      ],
    };

    const fakeFileId = f.store.capture(
      f.who,
      f.reviewId,
      fake,
      f.mutation(),
    ).files[0]!;

    expect(f.store.readFile(f.who, f.reviewId, fakeFileId)).toMatchObject({
      old_path: "src/main.ts",
      new_path: "src/entry.ts",
      oldText: `${f.text}plus\n`,
      newText: f.text,
      file_identity: null,
    });
    expect(f.store.project(f.who, f.thread.threadId, fakeFileId)).toMatchObject({
      status: "missing",
      startLine: null,
      endLine: null,
      side: "new",
    });
  } finally {
    f.cleanup();
  }
});
