import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

import { ReviewError, type ReviewIdentity } from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";
import { SourceReader } from "./source.js";

const PATH_PREFIX = "piclaw://addon/code-review/";
const LONG_SEGMENT = "wrap_segment_".repeat(12);
const OLD_MARKER = `const marker\t= "<old data-note='safe'>${LONG_SEGMENT}</old>";`;
const STAGED_MARKER = `const marker\t= "<staged data-note='safe'>${LONG_SEGMENT}</staged>";`;
const WORKTREE_MARKER = `const marker\t= "<worktree data-note='safe'>${LONG_SEGMENT}</worktree>";`;
const OLD_TEXT = [
  "const before = 1;",
  "/* first",
  " * const still comment",
  " */",
  "const gap01 = 1;",
  "const gap02 = 2;",
  "const gap03 = 3;",
  "const gap04 = 4;",
  "const gap05 = 5;",
  "const gap06 = 6;",
  "const gap07 = 7;",
  "const gap08 = 8;",
  "const gap09 = 9;",
  "const gap10 = 10;",
  "const gap11 = 11;",
  "const gap12 = 12;",
  OLD_MARKER,
  "const after = 2;",
].join("\n") + "\n";
const STAGED_TEXT = [
  "const before = 1;",
  "const stillComment = 2;",
  "const template = `first",
  "second`;",
  "const gap01 = 1;",
  "const gap02 = 2;",
  "const gap03 = 3;",
  "const gap04 = 4;",
  "const gap05 = 5;",
  "const gap06 = 6;",
  "const gap07 = 7;",
  "const gap08 = 8;",
  "const gap09 = 9;",
  "const gap10 = 10;",
  "const gap11 = 11;",
  "const gap12 = 12;",
  STAGED_MARKER,
  "const after = 2;",
].join("\n") + "\n";
const WORKTREE_TEXT = [
  "const before = 1;",
  "const stillComment = 2;",
  "const template = `first",
  "second`;",
  "const gap01 = 1;",
  "const gap02 = 2;",
  "const gap03 = 3;",
  "const gap04 = 4;",
  "const gap05 = 5;",
  "const gap06 = 6;",
  "const gap07 = 7;",
  "const gap08 = 8;",
  "const gap09 = 9;",
  "const gap10 = 10;",
  "const gap11 = 11;",
  "const gap12 = 12;",
  WORKTREE_MARKER,
  "const after = 2;",
].join("\n") + "\n";
const THREAD_BODY = "Keep the old-side discussion attached to the deleted comment block.";

let harnessSerial = 0;

type RepoState = {
  head: string;
  status: string;
  index: Buffer;
  worktree: Buffer;
};

type QueueCall = {
  target: { chatJid: string; incarnation: string };
  content: string;
  mode: "queue";
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
  const root = mkdtempSync(join(tmpdir(), `review-diff-pane-${serial}-`));
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });

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

  writeFileSync(join(repoDir, "sample.ts"), OLD_TEXT);
  git("add", "sample.ts");
  git("commit", "-qm", "base");
  writeFileSync(join(repoDir, "sample.ts"), STAGED_TEXT);
  git("add", "sample.ts");
  writeFileSync(join(repoDir, "sample.ts"), WORKTREE_TEXT);

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
    worktree: readFileSync(join(repoDir, "sample.ts")),
  });

  const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:calc(100% - 40px)}</style></head><body><button id="open-review">Open review</button><main id="pane"></main><script>let pane;window.__codeReviewReady=false;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};document.getElementById('open-review').onclick=()=>window.__piclaw_web.openPane({path:${JSON.stringify(PATH_PREFIX)}});</script><script type="module" src="/web/index.ts"></script></body></html>`;

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

  const launchPage = async () => {
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

  const waitForShell = async (page: any) => {
    await page.goto(server.url.href);
    await page.waitForFunction(
      () =>
        (window as any).__codeReviewReady === true &&
        document.querySelector("#open-review") !== null,
    );
  };

  const openReview = async (page: any, reviewId: string) => {
    await page.evaluate((path: string) => {
      const open = (window as any).__piclaw_web?.openPane;
      if (!open) throw Error("Pane bridge unavailable.");
      open({ path });
    }, PATH_PREFIX + reviewId);
    await page.waitForSelector(".cr-line");
    await page.waitForFunction(
      () =>
        document.querySelector(".cr-file-header strong")?.textContent ===
        "sample.ts",
    );
  };

  return {
    repoDir,
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
  expect(actual.worktree.equals(expected.worktree)).toBe(true);
}

test(
  "CR-006/119/142/148/149 diff pane preserves exact saved bytes and Git state across layout, context, wrap, staged and unstaged reads",
  async () => {
    const harness = createHarness("diff-pane");
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const baseline = harness.repoState();
      const stagedCapture = await harness.reader.capture({
        path: "sample.ts",
        mode: "staged",
      });
      const unstagedCapture = await harness.reader.capture({
        path: "sample.ts",
        mode: "unstaged",
      });
      expectRepoUnchanged(harness.repoState(), baseline);
      expect(stagedCapture.files).toHaveLength(1);
      expect(stagedCapture.files[0]).toMatchObject({
        oldPath: "sample.ts",
        newPath: "sample.ts",
        change: "modified",
        oldText: OLD_TEXT,
        newText: STAGED_TEXT,
      });
      expect(unstagedCapture.files[0]).toMatchObject({
        oldPath: "sample.ts",
        newPath: "sample.ts",
        change: "modified",
        oldText: STAGED_TEXT,
        newText: WORKTREE_TEXT,
      });

      const review = harness.store.createFromCapture(
        harness.operator,
        {
          title: "Diff pane acceptance",
          focusPath: "sample.ts",
          target: harness.target,
        },
        stagedCapture,
        harness.mutation(),
      );
      const stagedFileId = review.files[0]!;
      expect(harness.store.readFile(harness.operator, review.reviewId, stagedFileId)).toMatchObject({
        oldText: OLD_TEXT,
        newText: STAGED_TEXT,
        old_path: "sample.ts",
        new_path: "sample.ts",
        change_kind: "modified",
      });
      expectRepoUnchanged(harness.repoState(), baseline);

      const thread = await reviewAction(
        harness.ctx,
        "comment",
        {
          reviewId: review.reviewId,
          fileId: stagedFileId,
          side: "old",
          range: { startLine: 2, endLine: 2 },
          body: THREAD_BODY,
          requestId: harness.mutation().requestId,
        },
        harness.store,
      ) as { threadId: string };
      expectRepoUnchanged(harness.repoState(), baseline);

      const launched = await harness.launchPage();
      browser = launched.browser;
      const { page, errors } = launched;
      await harness.waitForShell(page);
      await harness.openReview(page, review.reviewId);
      await page.waitForSelector(`#cr-${thread.threadId}`);

      expect(await page.locator(".cr-file-header .cr-muted").textContent()).toContain(
        "staged",
      );
      expect(await page.locator(".cr-expand").count()).toBeGreaterThan(0);
      expect(await page.locator('.cr-line.deleted[data-side="old"][data-line="2"] > button:nth-of-type(2)').textContent()).toBe("2");
      expect(await page.locator('.cr-line.added[data-side="new"][data-line="3"] > button:nth-of-type(2)').textContent()).toBe("3");
      expect(await page.locator('.cr-line.deleted[data-side="old"][data-line="2"] code').innerHTML()).toContain("tok-comment");
      expect(await page.locator('.cr-line.added[data-side="new"][data-line="2"] code').innerHTML()).not.toContain("tok-comment");
      expect(await page.locator('.cr-line.added[data-side="new"][data-line="3"] code').innerHTML()).toContain("tok-string2");
      expect(await page.locator(`#cr-${thread.threadId} header .cr-muted`).textContent()).toBe(
        "old lines 2–2",
      );
      await page.locator(`#cr-${thread.threadId} [data-action=expand]`).click();
      expect(await page.locator(`#cr-${thread.threadId} .cr-message-body`).innerText()).toContain(
        THREAD_BODY,
      );
      expect(await page.locator('.cr-line.context[data-side="new"][data-line="12"]').count()).toBe(0);
      expectRepoUnchanged(harness.repoState(), baseline);

      await page.locator('.cr-toolbar [data-action="options"]').click();
      await page.locator('.cr-menu [data-action="layout"]').click();
      await page.waitForSelector(".cr-pair");
      expect(await page.locator(".cr-pair").count()).toBeGreaterThan(0);
      const deletedPair = page
        .locator(".cr-pair")
        .filter({
          has: page.locator('.cr-line.deleted[data-side="old"][data-line="2"]'),
        })
        .first();
      expect(await deletedPair.locator(".cr-blank").count()).toBe(1);
      expect(await page.locator('.cr-pair .cr-line.deleted[data-side="old"][data-line="2"] code').innerHTML()).toContain("tok-comment");
      expect(await page.locator('.cr-pair .cr-line.added[data-side="new"][data-line="3"] code').innerHTML()).toContain("tok-string2");
      expect(await page.locator(`#cr-${thread.threadId} header .cr-muted`).textContent()).toBe(
        "old lines 2–2",
      );

      await page.locator(".cr-expand").first().click();
      await page.waitForSelector('.cr-line.context[data-side="new"][data-line="12"]');
      expect(await page.locator(".cr-expand").count()).toBe(0);

      const markerRow = page.locator('.cr-line.added[data-side="new"][data-line="17"] code').first();
      expect(await markerRow.textContent()).toBe(STAGED_MARKER);
      const beforeWrap = await markerRow.evaluate((node) => getComputedStyle(node).whiteSpace);
      expect(beforeWrap).toBe("pre");
      await page.locator('.cr-toolbar [data-action="options"]').click();
      await page.locator('.cr-menu [data-action="wrap"]').click();
      await page.waitForFunction(
        () => document.querySelector(".cr-source")?.classList.contains("wrap") === true,
      );
      expect(await markerRow.textContent()).toBe(STAGED_MARKER);
      const afterWrap = await markerRow.evaluate((node) => getComputedStyle(node).whiteSpace);
      expect(afterWrap).toBe("pre-wrap");
      expectRepoUnchanged(harness.repoState(), baseline);

      await page.locator('.cr-toolbar [data-action="options"]').click();
      await page.locator('.cr-menu [data-action="unstaged"]').click();
      await page.waitForFunction(
        () => document.querySelector(".cr-file-header .cr-muted")?.textContent?.includes("unstaged") === true,
      );
      const unstagedMarker = page.locator('.cr-line.added[data-side="new"][data-line="17"] code').first();
      expect(await unstagedMarker.textContent()).toBe(WORKTREE_MARKER);
      expectRepoUnchanged(harness.repoState(), baseline);

      const unstagedSnapshots = await reviewAction(
        harness.ctx,
        "snapshots",
        { reviewId: review.reviewId },
        harness.store,
      ) as Array<{ id: string; mode: string }>;
      const unstagedSnapshot = unstagedSnapshots.find((row) => row.mode === "unstaged");
      expect(unstagedSnapshot).toBeTruthy();
      const unstagedFiles = await reviewAction(
        harness.ctx,
        "files",
        { reviewId: review.reviewId, snapshotId: unstagedSnapshot!.id },
        harness.store,
      ) as Array<{ id: string }>;
      const unstagedFile = unstagedFiles[0]!;
      expect(harness.store.readFile(harness.operator, review.reviewId, unstagedFile.id)).toMatchObject({
        oldText: unstagedCapture.files[0]!.oldText,
        newText: unstagedCapture.files[0]!.newText,
        old_path: "sample.ts",
        new_path: "sample.ts",
        change_kind: "modified",
      });

      await page.locator('.cr-toolbar [data-action="options"]').click();
      await page.locator('.cr-menu [data-action="staged"]').click();
      await page.waitForFunction(
        () => document.querySelector(".cr-file-header .cr-muted")?.textContent?.trim().startsWith("staged") === true,
      );
      expect(await page.locator('.cr-line.added[data-side="new"][data-line="17"] code').first().textContent()).toBe(
        STAGED_MARKER,
      );
      expectRepoUnchanged(harness.repoState(), baseline);

      const snapshots = await reviewAction(
        harness.ctx,
        "snapshots",
        { reviewId: review.reviewId },
        harness.store,
      ) as Array<{ id: string; mode: string }>;
      expect(snapshots[0]?.mode).toBe("staged");
      const latestFiles = await reviewAction(
        harness.ctx,
        "files",
        { reviewId: review.reviewId, snapshotId: snapshots[0]!.id },
        harness.store,
      ) as Array<{ id: string }>;
      expect(harness.store.readFile(harness.operator, review.reviewId, latestFiles[0]!.id)).toMatchObject({
        oldText: stagedCapture.files[0]!.oldText,
        newText: stagedCapture.files[0]!.newText,
        old_path: "sample.ts",
        new_path: "sample.ts",
        change_kind: "modified",
      });
      expect(harness.queueCalls).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      harness.cleanup();
    }
  },
  60_000,
);
