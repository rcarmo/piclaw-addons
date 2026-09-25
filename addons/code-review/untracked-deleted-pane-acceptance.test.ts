import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

import type { ReviewIdentity } from "./contracts.js";
import { ReviewError } from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";
import { SourceReader } from "./source.js";

const PATH_PREFIX = "piclaw://addon/code-review/";
const DELETED_BODY = "Keep this deleted implementation note visible during cleanup.";
const FILE_BODY = "Check the new file at whole-file scope before wiring it in.";

let harnessSerial = 0;

type QueueCall = {
  target: { chatJid: string; incarnation: string };
  content: string;
  mode: "queue";
};

type RepoState = {
  head: string;
  status: string;
  index: Buffer;
  deletedExists: boolean;
  added: Buffer;
};

type CreatedReview = {
  reviewId: string;
  version: number;
  snapshotId: string;
  files: string[];
};

type BrowserSession = {
  browser: Browser;
  page: Page;
  errors: string[];
};

function browserExecutable() {
  const explicit =
    process.env.PICLAW_REVIEW_BATCH_TEST_BROWSER ||
    process.env.PICLAW_REVIEW_TEST_BROWSER;
  if (explicit) return explicit;
  for (const home of ["/home/agent", process.env.HOME || ""]) {
    if (!home) continue;
    const root = join(home, ".cache", "ms-playwright");
    try {
      for (const dir of readdirSync(root)
        .filter((entry) => entry.startsWith("chromium_headless_shell-"))
        .sort()
        .reverse()) {
        const candidate = join(
          root,
          dir,
          "chrome-headless-shell-linux64",
          "chrome-headless-shell",
        );
        if (existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return undefined;
}

function browserEnv() {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME"])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

function createHarness(name: string) {
  const serial = `${name}-${++harnessSerial}`;
  const root = mkdtempSync(join(tmpdir(), `review-untracked-deleted-${serial}-`));
  const repoDir = join(root, "repo");
  const srcDir = join(repoDir, "src");
  mkdirSync(srcDir, { recursive: true });

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

  const deletedPath = join(srcDir, "old.ts");
  const addedPath = join(srcDir, "new.ts");
  const deletedText = [
    "export const oldLine = 1;",
    "export const oldLine = 2;",
    "export const oldLine = 3;",
  ].join("\n") + "\n";
  const addedText = [
    "export const freshLine = 1;",
    "export const freshLine = 2;",
  ].join("\n") + "\n";

  writeFileSync(deletedPath, deletedText);
  git("add", "src/old.ts");
  git("commit", "-qm", "base");
  unlinkSync(deletedPath);
  writeFileSync(addedPath, addedText);

  const reader = new SourceReader(repoDir, `workspace:${serial}`);
  const store = new ReviewService(join(root, "review.db"));
  const operator: ReviewIdentity = {
    ownerId: `owner:${serial}`,
    actorId: `operator:${serial}`,
    kind: "operator",
    workspaceId: `workspace:${serial}`,
  };
  const target = {
    chatId: `web:worker:${serial}`,
    incarnation: `chat:${serial}`,
    label: "Implementation",
  };
  const hostTarget = {
    chatJid: target.chatId,
    incarnation: target.incarnation,
    label: target.label,
    agentName: "implementation",
    active: true,
  };
  let request = 0;
  const mutation = (expectedVersion?: number) => ({
    requestId: `req:${serial}:${++request}`,
    expectedVersion,
  });
  const queueCalls: QueueCall[] = [];
  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: operator.ownerId,
    actorId: operator.actorId,
    kind: "operator",
    workspaceRoot: repoDir,
    workspaceId: operator.workspaceId!,
    async listTargets() {
      return [hostTarget];
    },
    async resolveTarget(input) {
      return (
        (input.chatJid === undefined || input.chatJid === hostTarget.chatJid) &&
        (input.agentName === undefined || input.agentName === hostTarget.agentName) &&
        (input.incarnation === undefined || input.incarnation === hostTarget.incarnation)
      )
        ? hostTarget
        : null;
    },
    async enqueue(input) {
      queueCalls.push(input);
      return { status: "accepted" as const, rowId: queueCalls.length * 100 };
    },
  };

  const repoState = (): RepoState => ({
    head: git("rev-parse", "HEAD"),
    status: git("status", "--porcelain=v1"),
    index: readFileSync(join(repoDir, ".git", "index")),
    deletedExists: existsSync(deletedPath),
    added: readFileSync(addedPath),
  });

  const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:100%}</style></head><body><main id="pane"></main><script>window.__codeReviewReady=false;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){window.__pane=p;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.__instance=window.__pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};</script><script type="module" src="/web/index.ts"></script></body></html>`;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/")
        return new Response(shell, {
          headers: { "Content-Type": "text/html" },
        });
      if (["/web/index.ts", "/web/api.ts", "/web/pane.ts", "/web/styles.ts"].includes(path))
        return new Response(
          transpile.transformSync(
            await Bun.file(join(import.meta.dir, path.slice(1))).text(),
          ),
          { headers: { "Content-Type": "text/javascript" } },
        );
      if (path === "/agent/addons/api/code-review/action") {
        try {
          const body = await req.json();
          return Response.json({
            ok: true,
            result: await reviewAction(ctx, body.action, body, store),
          });
        } catch (error) {
          const reviewError =
            error instanceof ReviewError
              ? error
              : new ReviewError(
                  "failed",
                  (error as Error).message || "Review request failed.",
                  500,
                );
          return Response.json(
            {
              ok: false,
              error: {
                code: reviewError.code,
                status: reviewError.status,
                message: reviewError.message,
              },
            },
            { status: reviewError.status },
          );
        }
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const launchPage = async (): Promise<BrowserSession> => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: browserExecutable(),
      args: ["--no-sandbox"],
      env: browserEnv(),
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return { browser, page, errors };
  };

  const waitForShell = async (page: Page) => {
    await page.goto(server.url.href);
    await page.waitForFunction(() => (window as any).__codeReviewReady === true);
  };

  const openReview = async (page: Page, reviewId: string, path: string) => {
    await page.evaluate((reviewPath: string) => {
      const open = (window as any).__piclaw_web?.openPane;
      if (!open) throw Error("Pane bridge unavailable.");
      open({ path: reviewPath });
    }, PATH_PREFIX + reviewId);
    await page.waitForSelector(".cr-line, .cr-empty");
    // Snapshot files are sorted by path; navigate explicitly to the deleted file.
    if ((await page.locator(".cr-file-header strong").textContent()) !== path) {
      await page.locator(".cr-files [data-action=file]").filter({ hasText: path }).click();
    }
    await page.waitForFunction(
      (expectedPath) => document.querySelector(".cr-file-header strong")?.textContent === expectedPath,
      path,
    );
  };

  return {
    repoDir,
    deletedPath,
    addedPath,
    deletedText,
    addedText,
    git,
    reader,
    store,
    operator,
    ctx,
    target,
    mutation,
    queueCalls,
    repoState,
    launchPage,
    waitForShell,
    openReview,
    cleanup() {
      server.stop(true);
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function expectRepoUnchanged(actual: RepoState, expected: RepoState) {
  expect(actual.head).toBe(expected.head);
  expect(actual.status).toBe(expected.status);
  expect(actual.index.equals(expected.index)).toBe(true);
  expect(actual.deletedExists).toBe(expected.deletedExists);
  expect(actual.added.equals(expected.added)).toBe(true);
}

async function switchToFile(page: Page, path: string) {
  if (!(await page.locator(".cr-files").evaluate((el) => el.classList.contains("open"))))
    await page.locator('.cr-toolbar [data-action="files"]').click();
  await page.waitForSelector(".cr-files.open");
  await page
    .locator(".cr-files [data-action=file]")
    .filter({ hasText: path })
    .first()
    .click();
  await page.waitForFunction(
    (expectedPath) =>
      document.querySelector(".cr-file-header strong")?.textContent ===
      expectedPath,
    path,
  );
}

test(
  "CR-007 browser review shows deleted old-side and untracked new-side discussions without touching Git or queueing work",
  async () => {
    const harness = createHarness("untracked-deleted-pane");
    let browser: Browser | undefined;
    try {
      const baseline = harness.repoState();
      const capture = await harness.reader.capture({
        path: ".",
        mode: "unstaged",
        includeUntracked: true,
      });
      expectRepoUnchanged(harness.repoState(), baseline);
      expect(capture.mode).toBe("unstaged");
      expect(capture.files).toHaveLength(2);
      expect(capture.files[0]).toMatchObject({
        oldPath: "src/old.ts",
        newPath: null,
        change: "deleted",
        oldText: harness.deletedText,
        newText: null,
      });
      expect(capture.files[1]).toMatchObject({
        oldPath: null,
        newPath: "src/new.ts",
        change: "added",
        oldText: null,
        newText: harness.addedText,
      });

      const review = harness.store.createFromCapture(
        harness.operator,
        {
          title: "CR-007 untracked + deleted",
          focusPath: ".",
          target: harness.target,
        },
        capture,
        harness.mutation(),
      ) as CreatedReview;
      expectRepoUnchanged(harness.repoState(), baseline);
      expect(harness.store.readFile(harness.operator, review.reviewId, review.files[0]!)).toMatchObject({
        old_path: "src/old.ts",
        new_path: null,
        change_kind: "deleted",
        oldText: harness.deletedText,
        newText: null,
      });
      expect(harness.store.readFile(harness.operator, review.reviewId, review.files[1]!)).toMatchObject({
        old_path: null,
        new_path: "src/new.ts",
        change_kind: "added",
        oldText: null,
        newText: harness.addedText,
      });

      const launched = await harness.launchPage();
      browser = launched.browser;
      const { page, errors } = launched;
      await harness.waitForShell(page);
      await harness.openReview(page, review.reviewId, "src/old.ts");

      expect(await page.locator('.cr-line[data-side="old"][data-line]').count()).toBe(3);
      expect(await page.locator('.cr-line[data-side="new"][data-line]').count()).toBe(0);
      expect(await page.locator('.cr-line.deleted[data-side="old"][data-line="2"] code').textContent()).toBe(
        "export const oldLine = 2;",
      );

      await page.locator('[data-action=line-comment][data-side="old"][data-line="2"]').click();
      await page.locator("#cr-body").fill(DELETED_BODY);
      await page.locator('[data-action="post"]').click();
      await page.waitForSelector(".cr-thread");
      expect(await page.locator(".cr-thread header .cr-muted").first().textContent()).toBe(
        "old lines 2–2",
      );
      if (await page.locator('.cr-thread [data-action="expand"]').first().getAttribute("aria-expanded") !== "true") await page.locator('.cr-thread [data-action="expand"]').first().click();
      await page.waitForFunction(
        (body) =>
          document.querySelector(".cr-thread .cr-message-body")?.textContent === body,
        DELETED_BODY,
      );

      const deletedThreadId = harness.store.listThreads(harness.operator, review.reviewId)[0]!.id;
      const deletedThread = harness.store.getThread(harness.operator, deletedThreadId);
      expect(deletedThread.anchor).toMatchObject({
        scope: "range",
        side: "old",
        startLine: 2,
        endLine: 2,
      });
      expect(deletedThread.source).toMatchObject({
        oldPath: "src/old.ts",
        newPath: null,
      });
      expectRepoUnchanged(harness.repoState(), baseline);

      await switchToFile(page, "src/new.ts");
      expect(await page.locator('.cr-line[data-side="new"][data-line]').count()).toBe(2);
      expect(await page.locator('.cr-line[data-side="old"][data-line]').count()).toBe(0);
      expect(await page.locator('.cr-line.added[data-side="new"][data-line="2"] code').textContent()).toBe(
        "export const freshLine = 2;",
      );

      await page.locator('[data-action="file-comment"]').click();
      await page.locator("#cr-body").fill(FILE_BODY);
      await page.locator('[data-action="post"]').click();
      await page.waitForSelector(".cr-thread");
      expect(await page.locator(".cr-thread header .cr-muted").first().textContent()).toBe(
        "Whole file",
      );
      if (await page.locator('.cr-thread [data-action="expand"]').first().getAttribute("aria-expanded") !== "true") await page.locator('.cr-thread [data-action="expand"]').first().click();
      await page.waitForFunction(
        (body) =>
          document.querySelector(".cr-thread .cr-message-body")?.textContent === body,
        FILE_BODY,
      );

      const threads = harness.store.listThreads(harness.operator, review.reviewId);
      expect(threads).toHaveLength(2);
      const fileThreadId = threads.find((thread) => thread.id !== deletedThreadId)?.id;
      expect(fileThreadId).toBeTruthy();
      const fileThread = harness.store.getThread(harness.operator, fileThreadId!);
      expect(fileThread.anchor).toMatchObject({
        scope: "file",
        side: "new",
        startLine: null,
        endLine: null,
      });
      expect(fileThread.source).toMatchObject({
        oldPath: null,
        newPath: "src/new.ts",
      });
      expectRepoUnchanged(harness.repoState(), baseline);

      await switchToFile(page, "src/old.ts");
      expect(await page.locator(".cr-thread .cr-message-body").textContent()).toBe(
        DELETED_BODY,
      );
      expect(await page.locator(".cr-thread header .cr-muted").first().textContent()).toBe(
        "old lines 2–2",
      );

      await switchToFile(page, "src/new.ts");
      expect(await page.locator(".cr-thread .cr-message-body").textContent()).toBe(
        FILE_BODY,
      );
      expect(await page.locator(".cr-thread header .cr-muted").first().textContent()).toBe(
        "Whole file",
      );

      expectRepoUnchanged(harness.repoState(), baseline);
      expect(harness.queueCalls).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      harness.cleanup();
    }
  },
  60_000,
);
