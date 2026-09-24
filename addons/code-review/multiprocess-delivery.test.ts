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

import { ReviewService } from "./dispatch.js";
import type {
  LocalTarget,
  ReviewIdentity,
  SourceCapture,
} from "./contracts.js";

const ADDON_DIR = import.meta.dir;
const DISPATCH_MODULE = join(ADDON_DIR, "dispatch.ts");
const CHILD_TIMEOUT_MS = 10_000;
let fixtureSerial = 0;

interface WorkerConfig {
  mode: "deliver" | "crash-after-claim";
  name: string;
  dbPath: string;
  dispatchId: string;
  operator: ReviewIdentity;
  markerPath: string;
  readyPath?: string;
  goPath?: string;
  resultPath?: string;
  rowId: number;
  sleepMs?: number;
  exitCode?: number;
}

interface ChildHandle {
  label: string;
  child: ChildProcess;
  done: Promise<void>;
}

const CHILD_PROGRAM = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { ReviewService } from ${JSON.stringify(DISPATCH_MODULE)};

const config = JSON.parse(await Bun.file(process.argv.at(-1)).text());
const waitFor = async (path) => {
  while (!existsSync(path)) await Bun.sleep(10);
};

if (config.readyPath) writeFileSync(config.readyPath, "ready");
if (config.goPath) await waitFor(config.goPath);

const service = new ReviewService(config.dbPath);
try {
  const result = await service.deliver(config.operator, config.dispatchId, {
    async enqueue(input) {
      appendFileSync(
        config.markerPath,
        JSON.stringify({
          name: config.name,
          rowId: config.rowId,
          target: input.target,
          mode: input.mode,
        }) + "\\n",
      );
      if (config.mode === "crash-after-claim") {
        process.exit(config.exitCode ?? 91);
      }
      if (config.sleepMs) await Bun.sleep(config.sleepMs);
      return { status: "accepted", rowId: config.rowId };
    },
  });
  if (config.resultPath) writeFileSync(config.resultPath, JSON.stringify(result));
  service.close();
} catch (error) {
  if (config.resultPath) {
    writeFileSync(
      config.resultPath,
      JSON.stringify({ error: String(error) }),
    );
  }
  service.close();
  throw error;
}
`;

function createFixture() {
  const serial = ++fixtureSerial;
  const workspaceId = `workspace:${serial}`;
  const worktreeId = `worktree:${serial}`;
  const dir = mkdtempSync(join(tmpdir(), `code-review-multiprocess-${serial}-`));
  const path = join(dir, "reviews.db");
  let store = new ReviewService(path);
  let closed = false;
  let request = 0;

  const operator: ReviewIdentity = {
    ownerId: `owner:${serial}`,
    actorId: `operator:${serial}`,
    kind: "operator",
    workspaceId,
  };
  const target: LocalTarget = {
    chatId: `web:worker:${serial}`,
    incarnation: `chat:${serial}`,
    label: "Worker",
  };
  const mutation = (expectedVersion?: number, requestId?: string) => ({
    requestId: requestId ?? `req-${serial}-${++request}`,
    expectedVersion,
  });

  const reviewId = store.createReview(
    operator,
    {
      workspaceId,
      worktreeId,
      title: "Multiprocess delivery",
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
        newText: "alpha\nbeta\ngamma\n",
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
      body: "Confirm the fallback path",
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
    path,
    operator,
    target,
    reviewId,
    mutation,
    close,
    reopen() {
      close();
      store = new ReviewService(path);
      closed = false;
      return store;
    },
    store: () => store,
    selection() {
      return {
        target,
        items: [{ threadId: thread.threadId, version: thread.version }],
      };
    },
    cleanup() {
      close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function markerLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function waitForFile(path: string, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}: ${path}`);
    }
    await Bun.sleep(10);
  }
}

function spawnWorker(config: WorkerConfig): ChildHandle {
  const configPath = join(
    join(config.dbPath, ".."),
    `${config.name}.${config.mode}.json`,
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

  const expectedExitCode =
    config.mode === "crash-after-claim" ? (config.exitCode ?? 91) : 0;
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === expectedExitCode) {
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
  // The worker can finish before the parent reaches waitForChild; retain its result.
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

async function waitForChild(handle: ChildHandle, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([handle.done, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        stopChild(handle);
        reject(new Error(`Timed out waiting for ${handle.label}`));
      }, timeoutMs);
    })]);
  } finally { clearTimeout(timeout); }
}

test("CR-176 two Bun workers claim one prepared enqueue attempt exactly once", async () => {
  const f = createFixture();
  const children: ChildHandle[] = [];
  try {
    const dispatch = f.store().submit(
      f.operator,
      f.reviewId,
      f.selection(),
      f.mutation(),
    );
    f.close();

    const markerPath = join(f.dir, "contention.enqueue.log");
    const goPath = join(f.dir, "contention.go");
    const readyA = join(f.dir, "worker-a.ready");
    const readyB = join(f.dir, "worker-b.ready");

    children.push(
      spawnWorker({
        mode: "deliver",
        name: "worker-a",
        dbPath: f.path,
        dispatchId: dispatch.dispatchId,
        operator: f.operator,
        markerPath,
        readyPath: readyA,
        goPath,
        resultPath: join(f.dir, "worker-a.result.json"),
        rowId: 801,
        sleepMs: 200,
      }),
      spawnWorker({
        mode: "deliver",
        name: "worker-b",
        dbPath: f.path,
        dispatchId: dispatch.dispatchId,
        operator: f.operator,
        markerPath,
        readyPath: readyB,
        goPath,
        resultPath: join(f.dir, "worker-b.result.json"),
        rowId: 802,
        sleepMs: 200,
      }),
    );

    await waitForFile(readyA, 1000, "worker-a ready");
    await waitForFile(readyB, 1000, "worker-b ready");
    writeFileSync(goPath, "go");

    await Promise.all(children.map((child) => waitForChild(child, CHILD_TIMEOUT_MS)));

    const enqueues = markerLines(markerPath);
    expect(enqueues).toHaveLength(1);
    const accepted = JSON.parse(enqueues[0]!) as {
      name: string;
      rowId: number;
      target: { chatId: string; incarnation: string };
      mode: string;
    };
    expect(accepted.target).toEqual({
      chatId: f.target.chatId,
      incarnation: f.target.incarnation,
    });
    expect(accepted.mode).toBe("queue");

    const reopened = f.reopen();
    const inspected = reopened.inspectDispatch(f.operator, dispatch.dispatchId);
    expect(inspected.attempts).toHaveLength(1);
    expect(inspected.attempts).toEqual([
      expect.objectContaining({
        id: dispatch.attemptId,
        number: 1,
        state: "accepted",
        host_row_id: accepted.rowId,
        error_code: null,
      }),
    ]);
    expect(inspected.attempts.filter((attempt) => attempt.state === "accepted")).toHaveLength(1);
  } finally {
    await Promise.all(children.map((child) => ensureStopped(child)));
    f.cleanup();
  }
});

test("CR-176 crash after host acceptance recovers to unknown and does not resend", async () => {
  const f = createFixture();
  const children: ChildHandle[] = [];
  try {
    const dispatch = f.store().submit(
      f.operator,
      f.reviewId,
      f.selection(),
      f.mutation(),
    );
    f.close();

    const markerPath = join(f.dir, "crash.enqueue.log");
    const goPath = join(f.dir, "crash.go");
    const readyPath = join(f.dir, "crash.ready");

    children.push(
      spawnWorker({
        mode: "crash-after-claim",
        name: "worker-crash",
        dbPath: f.path,
        dispatchId: dispatch.dispatchId,
        operator: f.operator,
        markerPath,
        readyPath,
        goPath,
        resultPath: join(f.dir, "worker-crash.result.json"),
        rowId: 901,
        exitCode: 91,
      }),
    );

    await waitForFile(readyPath, 1000, "crash worker ready");
    writeFileSync(goPath, "go");
    await waitForChild(children[0]!, CHILD_TIMEOUT_MS);

    expect(markerLines(markerPath)).toHaveLength(1);

    const reopened = f.reopen();
    expect(reopened.recoverInterrupted()).toBe(1);
    const recovered = reopened.inspectDispatch(f.operator, dispatch.dispatchId);
    expect(recovered.attempts).toEqual([
      expect.objectContaining({
        id: dispatch.attemptId,
        number: 1,
        state: "unknown",
        host_row_id: null,
        error_code: "interrupted",
      }),
    ]);

    let replayCalls = 0;
    const replay = await reopened.deliver(f.operator, dispatch.dispatchId, {
      async enqueue() {
        replayCalls += 1;
        return { status: "accepted" as const, rowId: 999 };
      },
    });
    expect(replayCalls).toBe(0);
    expect(replay.attempts).toEqual([
      expect.objectContaining({
        id: dispatch.attemptId,
        number: 1,
        state: "unknown",
        host_row_id: null,
        error_code: "interrupted",
      }),
    ]);
    expect(markerLines(markerPath)).toHaveLength(1);
  } finally {
    await Promise.all(children.map((child) => ensureStopped(child)));
    f.cleanup();
  }
});
