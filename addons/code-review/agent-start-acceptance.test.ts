import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewService } from "./dispatch.js";
import type { HostTarget, LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";

const MAIN_BODY = "Selected main-thread guidance";
const UTIL_BODY = "Selected util-thread guidance";
const OTHER_BODY = "Unselected thread that must stay untouched";
const DRAFT_BODY = "Private draft that must never be dispatched";

let fixtureSerial = 0;

function createFixture() {
  const serial = ++fixtureSerial;
  const dir = mkdtempSync(join(tmpdir(), `code-review-agent-start-${serial}-`));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "main.ts"),
    "export const main = true;\nexport function keepMain() {\n  return 'main';\n}\n",
  );
  writeFileSync(
    join(dir, "src", "util.ts"),
    "export function utilFallback() {\n  return 'util';\n}\n",
  );

  const service = new ReviewService(join(dir, "reviews.db"));
  const currentTarget: HostTarget = {
    chatJid: `web:worker:${serial}`,
    incarnation: `chat:${serial}:1`,
    label: "Implementation",
    agentName: "worker",
    active: true,
  };
  const replacementTarget: HostTarget = {
    chatJid: currentTarget.chatJid,
    incarnation: `chat:${serial}:2`,
    label: "Implementation (next)",
    agentName: "worker-next",
    active: false,
  };
  const targets = [currentTarget, replacementTarget];
  let request = 0;
  let queueCalls = 0;
  let queuedContent = "";

  const resolveTarget = async (input: {
    chatJid?: string;
    agentName?: string;
    incarnation?: string;
  }) =>
    targets.find(
      (target) =>
        (!input.chatJid || target.chatJid === input.chatJid) &&
        (!input.agentName || target.agentName === input.agentName) &&
        (!input.incarnation || target.incarnation === input.incarnation),
    ) ?? null;

  const operatorCtx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: `owner:${serial}`,
    actorId: `operator:${serial}`,
    kind: "operator",
    workspaceRoot: dir,
    workspaceId: `workspace:${serial}`,
    async listTargets() {
      return targets;
    },
    resolveTarget,
    async enqueue(input) {
      queueCalls++;
      queuedContent = input.content;
      expect(input.mode).toBe("queue");
      return { status: "accepted", rowId: 4110 };
    },
  };
  const agentCtx: LocalContext = {
    ...operatorCtx,
    actorId: `agent:${serial}`,
    kind: "agent",
    chatJid: currentTarget.chatJid,
    chatIncarnation: currentTarget.incarnation,
  };

  return {
    dir,
    service,
    operatorCtx,
    agentCtx,
    currentTarget,
    replacementTarget,
    get queueCalls() {
      return queueCalls;
    },
    get queuedContent() {
      return queuedContent;
    },
    requestId(prefix: string) {
      request += 1;
      return `${prefix}:${serial}:${request}`;
    },
    cleanup() {
      service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("CR-105/110 accepted batch start revalidates items and keeps unselected guidance out of the dispatch", async () => {
  const f = createFixture();
  try {
    const created = (await reviewAction(
      f.operatorCtx,
      "create",
      {
        path: "src/main.ts",
        target: { agentName: f.currentTarget.agentName },
        requestId: f.requestId("create"),
      },
      f.service,
    )) as {
      reviewId: string;
      snapshotId: string;
      files: string[];
    };

    const expanded = (await reviewAction(
      f.operatorCtx,
      "addFile",
      {
        reviewId: created.reviewId,
        snapshotId: created.snapshotId,
        path: "src/util.ts",
        requestId: f.requestId("add-file"),
      },
      f.service,
    )) as {
      snapshotId: string;
      files: string[];
    };

    const files = (await reviewAction(
      f.operatorCtx,
      "files",
      { reviewId: created.reviewId, snapshotId: expanded.snapshotId },
      f.service,
    )) as Array<{ id: string; new_path: string | null }>;
    const mainFileId = files.find((file) => file.new_path === "src/main.ts")?.id;
    const utilFileId = files.find((file) => file.new_path === "src/util.ts")?.id;

    expect(mainFileId).toBeTruthy();
    expect(utilFileId).toBeTruthy();

    const mainThread = (await reviewAction(
      f.operatorCtx,
      "comment",
      {
        reviewId: created.reviewId,
        fileId: mainFileId,
        side: "source",
        range: { startLine: 1, endLine: 1 },
        body: MAIN_BODY,
        requestId: f.requestId("thread-main"),
      },
      f.service,
    )) as { threadId: string; version: number };
    const utilThread = (await reviewAction(
      f.operatorCtx,
      "comment",
      {
        reviewId: created.reviewId,
        fileId: utilFileId,
        side: "source",
        range: { startLine: 1, endLine: 1 },
        body: UTIL_BODY,
        requestId: f.requestId("thread-util"),
      },
      f.service,
    )) as { threadId: string; version: number };
    const otherThread = (await reviewAction(
      f.operatorCtx,
      "comment",
      {
        reviewId: created.reviewId,
        fileId: mainFileId,
        side: "source",
        range: { startLine: 2, endLine: 2 },
        body: OTHER_BODY,
        requestId: f.requestId("thread-other"),
      },
      f.service,
    )) as { threadId: string; version: number };

    await reviewAction(
      f.operatorCtx,
      "draft",
      {
        reviewId: created.reviewId,
        threadId: mainThread.threadId,
        body: DRAFT_BODY,
        requestId: f.requestId("draft"),
      },
      f.service,
    );

    const dispatch = (await reviewAction(
      f.operatorCtx,
      "send",
      {
        reviewId: created.reviewId,
        target: {
          chatId: f.currentTarget.chatJid,
          incarnation: f.currentTarget.incarnation,
        },
        summary: "Do not leak util details while starting the queued batch.",
        items: [
          { threadId: mainThread.threadId, version: mainThread.version },
          { threadId: utilThread.threadId, version: utilThread.version },
        ],
        requestId: f.requestId("send"),
      },
      f.service,
    )) as {
      id: string;
      items: Array<{ thread_id: string; version: number }>;
      attempts: Array<{ state: string }>;
    };

    expect(f.queueCalls).toBe(1);
    expect(dispatch.attempts[0]?.state).toBe("accepted");
    expect(f.queuedContent).toContain(created.reviewId);
    expect(f.queuedContent).toContain(dispatch.id);
    expect(f.queuedContent).not.toContain(MAIN_BODY);
    expect(f.queuedContent).not.toContain(UTIL_BODY);
    expect(f.queuedContent).not.toContain(OTHER_BODY);
    expect(f.queuedContent).not.toContain(DRAFT_BODY);

    await reviewAction(
      f.operatorCtx,
      "reassign",
      {
        threadId: utilThread.threadId,
        target: {
          chatId: f.replacementTarget.chatJid,
          incarnation: f.replacementTarget.incarnation,
        },
        expectedVersion: utilThread.version,
        requestId: f.requestId("reassign"),
      },
      f.service,
    );

    const agentDispatch = (await reviewAction(
      f.agentCtx,
      "dispatch",
      { dispatchId: dispatch.id },
      f.service,
    )) as {
      summary: string;
      items: Array<Record<string, unknown>>;
    };

    expect(agentDispatch.summary).toBe("");
    expect(agentDispatch.items.map((item) => item.thread_id)).toEqual([
      mainThread.threadId,
      utilThread.threadId,
    ]);

    const availableItem = agentDispatch.items[0]!;
    const unavailableItem = agentDispatch.items[1]!;
    expect(availableItem).toMatchObject({
      thread_id: mainThread.threadId,
      snapshot_file_id: mainFileId,
      currentThreadVersion: 1,
      currentThreadState: "open",
      work_state: "not_started",
    });
    expect(unavailableItem).toMatchObject({
      thread_id: utilThread.threadId,
      unavailable: true,
      work_state: "superseded",
    });
    expect(unavailableItem).not.toHaveProperty("snapshot_file_id");
    expect(unavailableItem).not.toHaveProperty("currentThreadVersion");
    expect(unavailableItem).not.toHaveProperty("currentThreadState");

    const dispatchText = JSON.stringify(agentDispatch);
    expect(dispatchText).not.toContain(UTIL_BODY);
    expect(dispatchText).not.toContain(OTHER_BODY);
    expect(dispatchText).not.toContain(DRAFT_BODY);
    expect(dispatchText).not.toContain("src/util.ts");
    expect(dispatchText).not.toContain("return 'util'");
    expect(dispatchText).not.toContain(otherThread.threadId);

    const liveMainThread = (await reviewAction(
      f.agentCtx,
      "thread",
      { threadId: mainThread.threadId },
      f.service,
    )) as {
      source: { newPath: string | null };
      currentSource?: { status: string };
      messages: Array<{ body: string | null }>;
    };
    expect(liveMainThread.source.newPath).toBe("src/main.ts");
    expect(liveMainThread.currentSource?.status).toBe("unchanged");
    expect(liveMainThread.messages.map((message) => message.body)).toEqual([
      MAIN_BODY,
    ]);
    expect(JSON.stringify(liveMainThread)).not.toContain(OTHER_BODY);
    expect(JSON.stringify(liveMainThread)).not.toContain(DRAFT_BODY);

    await expect(
      reviewAction(
        f.agentCtx,
        "thread",
        { threadId: utilThread.threadId },
        f.service,
      ),
    ).rejects.toThrow("unavailable");
    await expect(
      reviewAction(
        f.agentCtx,
        "drafts",
        { reviewId: created.reviewId },
        f.service,
      ),
    ).rejects.toThrow("Operator action");
    // A published, still-assigned thread may be read by this agent directly.
    // Selection controls dispatch membership, not durable assignment authority.
    const unselected = await reviewAction(
      f.agentCtx,
      "thread",
      { threadId: otherThread.threadId },
      f.service,
    ) as { messages: Array<{ body: string | null }> };
    expect(unselected.messages.map((message) => message.body)).toEqual([OTHER_BODY]);
    expect(JSON.stringify(unselected)).not.toContain(DRAFT_BODY);
  } finally {
    f.cleanup();
  }
});
