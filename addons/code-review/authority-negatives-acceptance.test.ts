import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewService } from "./dispatch.js";
import type { HostTarget, LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";

// Scope note: these tests exercise reviewAction with a fake trusted LocalContext
// and an owned file-backed ReviewService. They do not prove host-layer auth/CSRF
// protections or CR-079 prompt/session isolation.

let fixtureSerial = 0;

type Counts = {
  reviews: number;
  snapshots: number;
  threads: number;
  messages: number;
  events: number;
  dispatches: number;
  receipts: number;
};

function createFixture() {
  const serial = ++fixtureSerial;
  const dir = mkdtempSync(
    join(tmpdir(), `code-review-authority-negatives-${serial}-`),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.ts"), "export const main = 1;\n");
  writeFileSync(join(dir, "src", "side.ts"), "export const side = 2;\n");

  const env = {
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("add", ".");
  git("commit", "-qm", "base");

  const service = new ReviewService(join(dir, "reviews.db"));
  const current: HostTarget = {
    chatJid: `web:worker:${serial}`,
    incarnation: `life:${serial}:1`,
    label: "Worker",
    agentName: "worker",
    active: true,
  };
  const rotated: HostTarget = {
    chatJid: current.chatJid,
    incarnation: `life:${serial}:2`,
    label: "Worker (rotated)",
    agentName: "worker-next",
    active: true,
  };
  const other: HostTarget = {
    chatJid: `web:other:${serial}`,
    incarnation: `life:${serial}:other`,
    label: "Other",
    agentName: "other",
    active: true,
  };
  let availableTargets: HostTarget[] = [current, other];
  let request = 0;
  const listTargetCalls: number[] = [];
  const resolveTargetCalls: Array<{
    chatJid?: string;
    agentName?: string;
    incarnation?: string;
  }> = [];
  const enqueueCalls: Array<{
    target: { chatJid: string; incarnation: string };
    content: string;
    mode: "queue";
  }> = [];

  const resolveTarget = async (input: {
    chatJid?: string;
    agentName?: string;
    incarnation?: string;
  }) => {
    resolveTargetCalls.push({ ...input });
    return availableTargets.find(
      (target) =>
        (input.chatJid === undefined || target.chatJid === input.chatJid) &&
        (input.agentName === undefined ||
          target.agentName === input.agentName) &&
        (input.incarnation === undefined ||
          target.incarnation === input.incarnation),
    ) ?? null;
  };

  const operatorCtx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: `owner:${serial}`,
    actorId: `operator:${serial}`,
    kind: "operator",
    workspaceRoot: dir,
    workspaceId: `workspace:${serial}`,
    async listTargets() {
      listTargetCalls.push(Date.now());
      return [...availableTargets];
    },
    resolveTarget,
    async enqueue(input) {
      enqueueCalls.push(input);
      return { status: "accepted", rowId: 1 };
    },
  };

  const agentCtx = (target = current): LocalContext => ({
    ...operatorCtx,
    actorId: `agent:${target.incarnation}`,
    kind: "agent",
    chatJid: target.chatJid,
    chatIncarnation: target.incarnation,
  });

  const counts = (): Counts => ({
    reviews:
      service.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM reviews",
      )?.n ?? 0,
    snapshots:
      service.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM snapshots",
      )?.n ?? 0,
    threads:
      service.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM threads",
      )?.n ?? 0,
    messages:
      service.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages",
      )?.n ?? 0,
    events:
      service.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM events",
      )?.n ?? 0,
    dispatches:
      service.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM dispatches",
      )?.n ?? 0,
    receipts:
      service.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM request_receipts",
      )?.n ?? 0,
  });

  const reviewRow = (reviewId: string) =>
    service.database.get<{ target_json: string; version: number }>(
      "SELECT target_json, version FROM reviews WHERE id=?",
      reviewId,
    );
  const threadRow = (threadId: string) =>
    service.database.get<{
      target_json: string;
      version: number;
      assignment_epoch: number;
    }>(
      "SELECT target_json, version, assignment_epoch FROM threads WHERE id=?",
      threadId,
    );

  return {
    dir,
    git,
    service,
    current,
    rotated,
    other,
    operatorCtx,
    agentCtx,
    counts,
    reviewRow,
    threadRow,
    listTargetCalls,
    resolveTargetCalls,
    enqueueCalls,
    requestId(prefix: string) {
      request += 1;
      return `${prefix}:${serial}:${request}`;
    },
    setTargets(targets: HostTarget[]) {
      availableTargets = [...targets];
    },
    cleanup() {
      service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("CR-078 forged authority fields are rejected before host checks or store mutation", async () => {
  const f = createFixture();
  try {
    const before = f.counts();
    for (const [field, value] of [
      ["ownerId", "owner:forged"],
      ["actorId", "actor:forged"],
      ["kind", "agent"],
      ["workspaceRoot", "/tmp/elsewhere"],
      ["workspaceId", "workspace:forged"],
    ] as const) {
      const listBefore = f.listTargetCalls.length;
      const resolveBefore = f.resolveTargetCalls.length;
      await expect(
        reviewAction(
          f.operatorCtx,
          "create",
          {
            path: "src/main.ts",
            target: { agentName: f.current.agentName },
            requestId: f.requestId(`forged-${field}`),
            [field]: value,
          },
          f.service,
        ),
      ).rejects.toThrow("Authority fields");
      expect(f.listTargetCalls).toHaveLength(listBefore);
      expect(f.resolveTargetCalls).toHaveLength(resolveBefore);
      expect(f.counts()).toEqual(before);
    }
    expect(f.enqueueCalls).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("CR-080 unsupported contexts and absent local agent scope deny without fallback", async () => {
  const f = createFixture();
  try {
    const before = f.counts();

    await expect(reviewAction(null, "list", {}, f.service)).rejects.toThrow(
      "guarded operator action",
    );

    await expect(
      reviewAction(
        {
          ...f.operatorCtx,
          accessMode: "shared" as never,
        } as LocalContext,
        "list",
        {},
        f.service,
      ),
    ).rejects.toThrow("guarded operator action");

    await expect(
      reviewAction(
        {
          ...f.operatorCtx,
          actorId: "agent:missing",
          kind: "agent",
        },
        "list",
        {},
        f.service,
      ),
    ).rejects.toThrow("Verified agent chat identity is unavailable");

    f.setTargets([]);
    await expect(
      reviewAction(
        f.operatorCtx,
        "create",
        {
          path: "src/main.ts",
          target: { agentName: f.current.agentName },
          requestId: f.requestId("unsupported-target"),
        },
        f.service,
      ),
    ).rejects.toThrow("currently authorised local agent");

    expect(f.enqueueCalls).toEqual([]);
    expect(f.counts()).toEqual(before);
  } finally {
    f.cleanup();
  }
});

test("CR-078 stale selectors cannot redirect target authority and rotated agent lifetimes fail closed", async () => {
  const f = createFixture();
  try {
    const created = (await reviewAction(
      f.operatorCtx,
      "create",
      {
        path: "src/main.ts",
        target: { agentName: f.current.agentName },
        requestId: f.requestId("create"),
      },
      f.service,
    )) as { reviewId: string; files: string[] };
    const commented = (await reviewAction(
      f.operatorCtx,
      "comment",
      {
        reviewId: created.reviewId,
        fileId: created.files[0],
        side: "source",
        range: { startLine: 1, endLine: 1 },
        body: "Keep this scoped",
        requestId: f.requestId("comment"),
      },
      f.service,
    )) as { threadId: string; version: number };

    const reviewBefore = f.reviewRow(created.reviewId);
    await expect(
      reviewAction(
        f.operatorCtx,
        "target",
        {
          reviewId: created.reviewId,
          target: {
            chatId: f.current.chatJid,
            agentName: f.other.agentName,
          },
          expectedVersion: reviewBefore?.version,
          requestId: f.requestId("redirect-chat"),
        },
        f.service,
      ),
    ).rejects.toThrow("currently authorised local agent");
    expect(f.reviewRow(created.reviewId)).toEqual(reviewBefore);

    f.setTargets([f.rotated, f.other]);
    const threadBefore = f.threadRow(commented.threadId);
    await expect(
      reviewAction(
        f.operatorCtx,
        "reassign",
        {
          threadId: commented.threadId,
          target: {
            chatId: f.current.chatJid,
            incarnation: f.current.incarnation,
          },
          expectedVersion: threadBefore?.version,
          requestId: f.requestId("redirect-lifetime"),
        },
        f.service,
      ),
    ).rejects.toThrow("old aliases are not rebound automatically");
    expect(f.threadRow(commented.threadId)).toEqual(threadBefore);

    const rotated = (await reviewAction(
      f.operatorCtx,
      "reassign",
      {
        threadId: commented.threadId,
        target: {
          chatId: f.rotated.chatJid,
          incarnation: f.rotated.incarnation,
        },
        expectedVersion: threadBefore?.version,
        requestId: f.requestId("rotate"),
      },
      f.service,
    )) as { version: number; assignmentEpoch: number };

    const countsBeforeFailures = f.counts();
    await expect(
      reviewAction(
        f.agentCtx(f.current),
        "reply",
        {
          threadId: commented.threadId,
          body: "stale lifetime",
          expectedVersion: rotated.version,
          assignmentEpoch: 1,
          requestId: f.requestId("reply-old-incarnation"),
        },
        f.service,
      ),
    ).rejects.toThrow("Agent chat no longer exists");

    await expect(
      reviewAction(
        f.agentCtx(f.rotated),
        "reply",
        {
          threadId: commented.threadId,
          body: "stale epoch",
          expectedVersion: rotated.version,
          assignmentEpoch: 1,
          requestId: f.requestId("reply-old-epoch"),
        },
        f.service,
      ),
    ).rejects.toThrow("assignment changed");

    expect(f.counts()).toEqual(countsBeforeFailures);
  } finally {
    f.cleanup();
  }
});

test("CR-078 outsider owner or workspace cannot guess review or thread identifiers", async () => {
  const f = createFixture();
  try {
    const created = (await reviewAction(
      f.operatorCtx,
      "create",
      {
        path: "src/main.ts",
        target: { agentName: f.current.agentName },
        requestId: f.requestId("create"),
      },
      f.service,
    )) as { reviewId: string; files: string[] };
    const commented = (await reviewAction(
      f.operatorCtx,
      "comment",
      {
        reviewId: created.reviewId,
        fileId: created.files[0],
        side: "source",
        body: "Private thread",
        requestId: f.requestId("comment"),
      },
      f.service,
    )) as { threadId: string };

    const otherOwner: LocalContext = {
      ...f.operatorCtx,
      ownerId: "owner:outsider",
      actorId: "operator:outsider",
    };
    const otherWorkspace: LocalContext = {
      ...f.operatorCtx,
      workspaceId: "workspace:outsider",
    };

    expect(await reviewAction(otherOwner, "list", {}, f.service)).toEqual([]);
    await expect(
      reviewAction(
        otherOwner,
        "review",
        { reviewId: created.reviewId },
        f.service,
      ),
    ).rejects.toThrow("unavailable");
    await expect(
      reviewAction(
        otherOwner,
        "thread",
        { threadId: commented.threadId },
        f.service,
      ),
    ).rejects.toThrow("unavailable");

    expect(await reviewAction(otherWorkspace, "list", {}, f.service)).toEqual(
      [],
    );
    await expect(
      reviewAction(
        otherWorkspace,
        "review",
        { reviewId: created.reviewId },
        f.service,
      ),
    ).rejects.toThrow("unavailable");
    await expect(
      reviewAction(
        otherWorkspace,
        "thread",
        { threadId: commented.threadId },
        f.service,
      ),
    ).rejects.toThrow("unavailable");
  } finally {
    f.cleanup();
  }
});

test("CR-081 traversal symlink and crafted revision inputs fail before review creation or Git side effects", async () => {
  const f = createFixture();
  try {
    const before = f.counts();
    const marker = join(f.dir, "git-side-effect-marker.txt");
    const helper = join(f.dir, "git-side-effect.sh");
    writeFileSync(
      helper,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 1\n`,
    );
    chmodSync(helper, 0o755);
    f.git("config", "diff.external", helper);
    f.git("config", "core.fsmonitor", helper);
    symlinkSync("/etc/hosts", join(f.dir, "src", "escape-link.ts"));

    await expect(
      reviewAction(
        f.operatorCtx,
        "create",
        {
          path: "../escape",
          target: { agentName: f.current.agentName },
          requestId: f.requestId("path-traversal"),
        },
        f.service,
      ),
    ).rejects.toThrow("workspace-relative path");

    await expect(
      reviewAction(
        f.operatorCtx,
        "create",
        {
          path: "src/escape-link.ts",
          target: { agentName: f.current.agentName },
          requestId: f.requestId("symlink-escape"),
        },
        f.service,
      ),
    ).rejects.toThrow("symlinks");

    await expect(
      reviewAction(
        f.operatorCtx,
        "create",
        {
          path: ".",
          mode: "commit",
          commit: "--output=/tmp/evil",
          target: { agentName: f.current.agentName },
          requestId: f.requestId("revision-argument"),
        },
        f.service,
      ),
    ).rejects.toThrow("hexadecimal");

    expect(existsSync(marker)).toBe(false);
    expect(f.enqueueCalls).toEqual([]);
    expect(f.counts()).toEqual(before);
  } finally {
    f.cleanup();
  }
});
