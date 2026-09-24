import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  LocalTarget,
  ReviewIdentity,
  ReviewErrorShape,
  SourceCapture,
} from "./contracts.js";
import { ReviewService } from "./dispatch.js";

const ADDON_DIR = import.meta.dir;
const DISPATCH_MODULE = join(ADDON_DIR, "dispatch.ts");
const CHILD_TIMEOUT_MS = 10_000;
let fixtureSerial = 0;

interface ReplyWorkerConfig {
  name: string;
  action: "reply";
  dbPath: string;
  who: ReviewIdentity;
  threadId: string;
  body: string;
  requestId: string;
  expectedVersion: number;
  assignmentEpoch?: number;
  readyPath?: string;
  goPath?: string;
  resultPath: string;
}

interface DeleteWorkerConfig {
  name: string;
  action: "delete";
  dbPath: string;
  who: ReviewIdentity;
  threadId: string;
  requestId: string;
  expectedVersion: number;
  readyPath?: string;
  goPath?: string;
  resultPath: string;
}

type WorkerConfig = ReplyWorkerConfig | DeleteWorkerConfig;

interface WorkerSuccess {
  ok: true;
  action: WorkerConfig["action"];
  name: string;
  result: {
    threadId: string;
    version: number;
    messageId?: string;
  };
}

interface WorkerFailure {
  ok: false;
  action: WorkerConfig["action"];
  name: string;
  error: Partial<ReviewErrorShape> & { name?: string; message: string };
}

type WorkerResult = WorkerSuccess | WorkerFailure;

interface ChildHandle {
  label: string;
  child: ChildProcess;
  done: Promise<void>;
}

const CHILD_PROGRAM = `
import { existsSync, writeFileSync } from "node:fs";
import { ReviewService } from ${JSON.stringify(DISPATCH_MODULE)};

const config = JSON.parse(await Bun.file(process.argv.at(-1)).text());
const waitFor = async (path) => {
  while (!existsSync(path)) await Bun.sleep(5);
};
const serializeError = (error) => ({
  name: error?.name,
  message: error instanceof Error ? error.message : String(error),
  code: typeof error?.code === "string" ? error.code : undefined,
  status: typeof error?.status === "number" ? error.status : undefined,
});

if (config.readyPath) writeFileSync(config.readyPath, "ready");
if (config.goPath) await waitFor(config.goPath);

const service = new ReviewService(config.dbPath);
try {
  const mutation = {
    requestId: config.requestId,
    expectedVersion: config.expectedVersion,
  };
  const result =
    config.action === "reply"
      ? service.reply(
          config.who,
          config.threadId,
          config.body,
          mutation,
          config.assignmentEpoch,
        )
      : service.deleteThread(config.who, config.threadId, mutation);
  writeFileSync(
    config.resultPath,
    JSON.stringify({
      ok: true,
      action: config.action,
      name: config.name,
      result,
    }),
  );
} catch (error) {
  writeFileSync(
    config.resultPath,
    JSON.stringify({
      ok: false,
      action: config.action,
      name: config.name,
      error: serializeError(error),
    }),
  );
} finally {
  service.close();
}
`;

function assertIntegrity(service: ReviewService) {
  expect(
    service.database.get<{ foreign_keys: number }>("PRAGMA foreign_keys")
      ?.foreign_keys,
  ).toBe(1);
  expect(
    service.database.all<Record<string, unknown>>("PRAGMA foreign_key_check"),
  ).toEqual([]);
}

function createFixture() {
  const serial = ++fixtureSerial;
  const dir = mkdtempSync(join(tmpdir(), `code-review-thread-race-${serial}-`));
  const dbPath = join(dir, "reviews.db");
  let store = new ReviewService(dbPath);
  let closed = false;
  let request = 0;

  const workspaceId = `workspace:${serial}`;
  const worktreeId = `worktree:${serial}`;
  const operator: ReviewIdentity = {
    ownerId: `owner:${serial}`,
    actorId: `operator:${serial}`,
    kind: "operator",
    workspaceId,
  };
  const target: LocalTarget = {
    chatId: `web:thread-race:${serial}`,
    incarnation: `chat:${serial}`,
    label: "Thread Race",
  };
  const agent: ReviewIdentity = {
    ownerId: operator.ownerId,
    actorId: `agent:${serial}`,
    kind: "agent",
    chatId: target.chatId,
    chatIncarnation: target.incarnation,
  };
  const mutation = (expectedVersion?: number, requestId?: string) => ({
    requestId: requestId ?? `req:${serial}:${++request}`,
    expectedVersion,
  });

  const reviewId = store.createReview(
    operator,
    {
      workspaceId,
      worktreeId,
      title: "Multiprocess thread race",
      focusPath: "src/main.ts",
      target,
    },
    mutation(),
  ).reviewId;

  const capture: SourceCapture = {
    workspaceId,
    worktreeId,
    mode: "source",
    base: null,
    head: null,
    capturedAt: new Date().toISOString(),
    files: [
      {
        oldPath: null,
        newPath: "src/main.ts",
        change: "source",
        oldText: null,
        newText: ["export const value = 1;", "export function work() {", "  return value;", "}", ""].join("\n"),
        fileIdentity: `inode:${serial}`,
      },
    ],
  };
  const fileId = store.capture(operator, reviewId, capture, mutation()).files[0]!;
  const thread = store.createThread(
    operator,
    reviewId,
    {
      fileId,
      side: "source",
      range: { startLine: 2, endLine: 2 },
      body: "Root concern",
    },
    mutation(),
  );

  const close = () => {
    if (closed) return;
    store.close();
    closed = true;
  };

  return {
    dir,
    dbPath,
    reviewId,
    threadId: thread.threadId,
    rootMessageId: thread.messageId,
    operator,
    agent,
    close,
    reopen() {
      close();
      store = new ReviewService(dbPath);
      closed = false;
      return store;
    },
    cleanup() {
      close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function spawnWorker(config: WorkerConfig): ChildHandle {
  const configPath = join(
    ADDON_DIR,
    `.tmp-${config.name}-${config.action}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(configPath, JSON.stringify(config));

  const child = spawn(process.execPath, ["-e", CHILD_PROGRAM, configPath], {
    cwd: ADDON_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      rmSync(configPath, { force: true });
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${config.name} exited with ${code ?? signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });
  void done.catch(() => {});

  return { label: config.name, child, done };
}

function stopChild(handle: ChildHandle) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  handle.child.kill("SIGKILL");
}

async function ensureStopped(handle: ChildHandle) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  handle.child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    handle.child.once("close", () => resolve());
  });
}

async function waitForFile(path: string, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}: ${path}`);
    }
    await Bun.sleep(5);
  }
}

async function waitForChild(handle: ChildHandle, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handle.done,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          stopChild(handle);
          reject(new Error(`Timed out waiting for ${handle.label}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function readResult(path: string): WorkerResult {
  if (!existsSync(path)) throw new Error(`Missing child result: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as WorkerResult;
}

function expectConflict(result: WorkerFailure) {
  expect(result.error.code).toBe("conflict");
  expect(result.error.message).toContain("record changed");
}

function expectUnavailable(result: WorkerFailure) {
  expect(result.error.code).toBe("not_found");
  expect(result.error.message).toContain("unavailable");
}

test("CR-071 two Bun writers racing the same thread version accept exactly one reply durably", async () => {
  const f = createFixture();
  const children: ChildHandle[] = [];
  try {
    f.close();

    const goPath = join(f.dir, "replies.go");
    const operatorReady = join(f.dir, "operator.ready");
    const agentReady = join(f.dir, "agent.ready");
    const operatorResultPath = join(f.dir, "operator.result.json");
    const agentResultPath = join(f.dir, "agent.result.json");

    children.push(
      spawnWorker({
        name: "operator-reply",
        action: "reply",
        dbPath: f.dbPath,
        who: f.operator,
        threadId: f.threadId,
        body: "Operator reply wins this serial order",
        requestId: "operator-race",
        expectedVersion: 1,
        readyPath: operatorReady,
        goPath,
        resultPath: operatorResultPath,
      }),
      spawnWorker({
        name: "agent-reply",
        action: "reply",
        dbPath: f.dbPath,
        who: f.agent,
        threadId: f.threadId,
        body: "Agent reply wins this serial order",
        requestId: "agent-race",
        expectedVersion: 1,
        assignmentEpoch: 1,
        readyPath: agentReady,
        goPath,
        resultPath: agentResultPath,
      }),
    );

    await waitForFile(operatorReady, 1000, "operator ready");
    await waitForFile(agentReady, 1000, "agent ready");
    writeFileSync(goPath, "go");

    await Promise.all(children.map((child) => waitForChild(child, CHILD_TIMEOUT_MS)));

    const operatorResult = readResult(operatorResultPath);
    const agentResult = readResult(agentResultPath);
    const results = [operatorResult, agentResult];
    const successes = results.filter((result): result is WorkerSuccess => result.ok);
    const failures = results.filter((result): result is WorkerFailure => !result.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expectConflict(failures[0]!);

    const reopened = f.reopen();
    const thread = reopened.getThread(f.operator, f.threadId);
    const winner = successes[0]!;
    const winnerMessageId = winner.result.messageId!;
    const expectedAuthorId =
      winner.name === "operator-reply" ? f.operator.actorId : f.agent.actorId;
    const expectedBody =
      winner.name === "operator-reply"
        ? "Operator reply wins this serial order"
        : "Agent reply wins this serial order";

    expect(thread.state).toBe("open");
    expect(thread.version).toBe(2);
    expect(thread.messages.map((message) => message.ordinal)).toEqual([1, 2]);
    expect(thread.messages.map((message) => message.id)).toEqual([
      f.rootMessageId,
      winnerMessageId,
    ]);
    expect(thread.messages[1]).toMatchObject({
      id: winnerMessageId,
      ordinal: 2,
      author_id: expectedAuthorId,
      body: expectedBody,
      deleted: 0,
    });
    expect(
      reopened.database.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id=?",
        f.threadId,
      )?.n,
    ).toBe(2);
    assertIntegrity(reopened);
  } finally {
    await Promise.all(children.map((child) => ensureStopped(child)));
    f.cleanup();
  }
});

test("CR-072 two Bun writers racing reply and delete store exactly one serial outcome", async () => {
  const f = createFixture();
  const children: ChildHandle[] = [];
  try {
    f.close();

    const goPath = join(f.dir, "reply-delete.go");
    const replyReady = join(f.dir, "reply.ready");
    const deleteReady = join(f.dir, "delete.ready");
    const replyResultPath = join(f.dir, "reply.result.json");
    const deleteResultPath = join(f.dir, "delete.result.json");

    children.push(
      spawnWorker({
        name: "agent-reply",
        action: "reply",
        dbPath: f.dbPath,
        who: f.agent,
        threadId: f.threadId,
        body: "Still visible after the failed delete",
        requestId: "reply-race",
        expectedVersion: 1,
        assignmentEpoch: 1,
        readyPath: replyReady,
        goPath,
        resultPath: replyResultPath,
      }),
      spawnWorker({
        name: "operator-delete",
        action: "delete",
        dbPath: f.dbPath,
        who: f.operator,
        threadId: f.threadId,
        requestId: "delete-race",
        expectedVersion: 1,
        readyPath: deleteReady,
        goPath,
        resultPath: deleteResultPath,
      }),
    );

    await waitForFile(replyReady, 1000, "reply ready");
    await waitForFile(deleteReady, 1000, "delete ready");
    writeFileSync(goPath, "go");

    await Promise.all(children.map((child) => waitForChild(child, CHILD_TIMEOUT_MS)));

    const replyResult = readResult(replyResultPath);
    const deleteResult = readResult(deleteResultPath);
    const results = [replyResult, deleteResult];
    const successes = results.filter((result): result is WorkerSuccess => result.ok);
    const failures = results.filter((result): result is WorkerFailure => !result.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const reopened = f.reopen();
    const winner = successes[0]!;
    const loser = failures[0]!;

    if (winner.action === "delete") {
      expectUnavailable(loser);
      expect(reopened.listThreads(f.operator, f.reviewId)).toEqual([]);
      expect(() => reopened.getThread(f.operator, f.threadId)).toThrow(
        "unavailable",
      );
      expect(() => reopened.getThread(f.agent, f.threadId)).toThrow(
        "unavailable",
      );
      expect(
        reopened.database.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM messages WHERE thread_id=?",
          f.threadId,
        )?.n,
      ).toBe(1);
      expect(
        reopened.database.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND deleted=0",
          f.threadId,
        )?.n,
      ).toBe(0);
      expect(
        reopened.database.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM message_revisions WHERE message_id IN (SELECT id FROM messages WHERE thread_id=?) AND body IS NOT NULL",
          f.threadId,
        )?.n,
      ).toBe(0);
    } else {
      expectConflict(loser);
      const thread = reopened.getThread(f.operator, f.threadId);
      const winnerMessageId = winner.result.messageId!;
      expect(thread.state).toBe("open");
      expect(thread.version).toBe(2);
      expect(thread.messages.map((message) => message.ordinal)).toEqual([1, 2]);
      expect(thread.messages.map((message) => message.id)).toEqual([
        f.rootMessageId,
        winnerMessageId,
      ]);
      expect(thread.messages[1]).toMatchObject({
        id: winnerMessageId,
        ordinal: 2,
        author_id: f.agent.actorId,
        body: "Still visible after the failed delete",
        deleted: 0,
      });
      expect(reopened.listThreads(f.operator, f.reviewId)).toHaveLength(1);
      expect(
        reopened.database.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND deleted=0",
          f.threadId,
        )?.n,
      ).toBe(2);
    }

    assertIntegrity(reopened);
  } finally {
    await Promise.all(children.map((child) => ensureStopped(child)));
    f.cleanup();
  }
});
