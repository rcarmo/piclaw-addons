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
import { chromium, type Browser, type Page } from "playwright";

import type { ReviewIdentity } from "./contracts.js";
import { ReviewError } from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";
import { SourceReader } from "./source.js";

const PATH_PREFIX = "piclaw://addon/code-review/";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ROOT_FILE = "root.ts";
const ROOT_TEXT = [
  "export const root = true;",
  "export function createdAtRoot() {",
  "  return 'root';",
  "}",
].join("\n") + "\n";
const ROOT_COMMENT = "Keep this added root line under review.";
const FILE_COMMENT = "No code changed here, but verify the whole file guidance stays visible.";

let harnessSerial = 0;

type RepoState = {
  head: string;
  status: string;
  index: Buffer;
  source: Buffer;
};

type BrowserSession = {
  browser: Browser;
  page: Page;
  errors: string[];
};

type CreatedReview = {
  reviewId: string;
  version: number;
  snapshotId: string;
  files: string[];
};

function browserExecutable() {
  const explicit = process.env.PICLAW_REVIEW_TEST_BROWSER;
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

function expectRepoUnchanged(actual: RepoState, expected: RepoState) {
  expect(actual.head).toBe(expected.head);
  expect(actual.status).toBe(expected.status);
  expect(actual.index.equals(expected.index)).toBe(true);
  expect(actual.source.equals(expected.source)).toBe(true);
}

function createHarness(name: string) {
  const serial = `${name}-${++harnessSerial}`;
  const root = mkdtempSync(join(tmpdir(), `review-root-empty-${serial}-`));
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

  writeFileSync(join(repoDir, ROOT_FILE), ROOT_TEXT);
  git("add", ROOT_FILE);
  git("commit", "-qm", "root");
  const rootCommit = git("rev-parse", "HEAD");

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
  const requestId = (label: string) => `req:${serial}:${label}:${++request}`;
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
    async enqueue() {
      throw Error("CR-010 acceptance must not queue host work.");
    },
  };

  const repoState = (): RepoState => ({
    head: git("rev-parse", "HEAD"),
    status: git("status", "--porcelain=v1"),
    index: readFileSync(join(repoDir, ".git", "index")),
    source: readFileSync(join(repoDir, ROOT_FILE)),
  });

  const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:100%}</style></head><body><button id="open-review">Open review</button><main id="pane"></main><script>window.__codeReviewReady=false;let pane;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.__instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};</script><script type="module" src="/web/index.ts"></script></body></html>`;
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
    await page.waitForFunction(
      () =>
        (window as { __codeReviewReady?: boolean }).__codeReviewReady === true &&
        document.querySelector("#open-review") !== null,
    );
  };

  const openReview = async (page: Page, reviewId: string) => {
    await page.evaluate((path: string) => {
      const open = (window as { __piclaw_web?: { openPane?: (ctx: { path: string }) => boolean } }).__piclaw_web?.openPane;
      if (!open) throw Error("Pane bridge unavailable.");
      open({ path });
    }, PATH_PREFIX + reviewId);
    await page.waitForSelector("#cr-snapshot", { state: "attached" });
  };

  return {
    repoDir,
    git,
    rootCommit,
    reader,
    store,
    ctx,
    operator,
    target,
    requestId,
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

test(
  "CR-010 browser keeps root commits and unchanged snapshots honest without mutating Git",
  async () => {
    const harness = createHarness("cr010");
    let browser: Browser | undefined;
    try {
      const baseline = harness.repoState();

      const rootCapture = await harness.reader.capture({
        path: ".",
        mode: "commit",
        commit: harness.rootCommit,
      });
      const unchangedCapture = await harness.reader.capture({
        path: ROOT_FILE,
        mode: "unstaged",
      });

      expectRepoUnchanged(harness.repoState(), baseline);
      expect(rootCapture).toMatchObject({
        mode: "commit",
        base: EMPTY_TREE,
        head: harness.rootCommit,
      });
      expect(rootCapture.files).toHaveLength(1);
      expect(rootCapture.files[0]).toMatchObject({
        oldPath: null,
        newPath: ROOT_FILE,
        change: "added",
        oldText: null,
        newText: ROOT_TEXT,
      });
      expect(unchangedCapture.files).toHaveLength(1);
      expect(unchangedCapture.files[0]).toMatchObject({
        oldPath: ROOT_FILE,
        newPath: ROOT_FILE,
        change: "unchanged",
        oldText: ROOT_TEXT,
        newText: ROOT_TEXT,
      });

      const created = (await reviewAction(
        harness.ctx,
        "create",
        {
          path: ROOT_FILE,
          mode: "unstaged",
          target: { agentName: "implementation" },
          requestId: harness.requestId("create-unchanged"),
        },
        harness.store,
      )) as CreatedReview;
      const unchangedSnapshotId = created.snapshotId;
      const unchangedFileId = created.files[0]!;
      const rootSnapshot = (await reviewAction(
        harness.ctx,
        "capture",
        {
          reviewId: created.reviewId,
          source: {
            path: ".",
            mode: "commit",
            commit: harness.rootCommit,
          },
          requestId: harness.requestId("capture-root"),
        },
        harness.store,
      )) as { snapshotId: string; files: string[] };
      const rootSnapshotId = rootSnapshot.snapshotId;
      const rootFileId = rootSnapshot.files[0]!;

      expectRepoUnchanged(harness.repoState(), baseline);
      const snapshots = harness.store.listSnapshots(
        harness.ctx,
        created.reviewId,
      ) as Array<{
        id: string;
        mode: string;
        base: string | null;
        head: string | null;
      }>;
      expect(snapshots).toHaveLength(2);
      expect(snapshots.find((row) => row.id === rootSnapshotId)).toMatchObject({
        mode: "commit",
        base: EMPTY_TREE,
        head: harness.rootCommit,
      });
      expect(snapshots.find((row) => row.id === unchangedSnapshotId)).toMatchObject({
        mode: "unstaged",
      });
      expect(
        harness.store.readFile(harness.operator, created.reviewId, rootFileId),
      ).toMatchObject({
        old_path: null,
        new_path: ROOT_FILE,
        change_kind: "added",
        oldText: null,
        newText: ROOT_TEXT,
      });
      expect(
        harness.store.readFile(harness.operator, created.reviewId, unchangedFileId),
      ).toMatchObject({
        old_path: ROOT_FILE,
        new_path: ROOT_FILE,
        change_kind: "unchanged",
        oldText: ROOT_TEXT,
        newText: ROOT_TEXT,
      });

      const launched = await harness.launchPage();
      browser = launched.browser;
      const { page, errors } = launched;
      await harness.waitForShell(page);
      await harness.openReview(page, created.reviewId);

      if (!(await page.locator("#cr-snapshot").isVisible())) await page.locator(".cr-snapshot-history summary").click();
      await page.locator("#cr-snapshot").selectOption(rootSnapshotId);
      await page.waitForFunction(
        (snapshotId) =>
          (document.querySelector("#cr-snapshot") as HTMLSelectElement | null)
            ?.value === snapshotId,
        rootSnapshotId,
      );
      await page.waitForSelector(
        '[data-action="line-comment"][data-side="new"][data-line="1"]',
      );
      expect(await page.locator(".cr-file-header strong").textContent()).toBe(
        ROOT_FILE,
      );
      expect(await page.locator(".cr-line.added").count()).toBe(
        ROOT_TEXT.trimEnd().split("\n").length,
      );
      expect(await page.locator(".cr-line.deleted").count()).toBe(0);
      expect(await page.locator('.cr-line[data-side="old"]').count()).toBe(0);

      await page
        .locator('[data-action="line-comment"][data-side="new"][data-line="2"]')
        .click();
      await page.locator("#cr-body").fill(ROOT_COMMENT);
      await page.waitForTimeout(650);
      await page.locator('[data-action="post"]').click();
      await page.waitForFunction(
        () =>
          document.querySelector(".cr-status")?.textContent?.includes(
            "Comment saved",
          ) === true,
      );

      const rootThread = harness.store.listThreads(harness.ctx, created.reviewId)[0]!;
      const persistedRoot = harness.store.getThread(harness.ctx, rootThread.id);
      expect(persistedRoot.anchor).toMatchObject({
        snapshotFileId: rootFileId,
        scope: "range",
        side: "new",
        startLine: 2,
        endLine: 2,
      });
      expect(await page.locator(`#cr-${rootThread.id} [data-action="expand"]`).getAttribute("aria-expanded")).toBe("true");
      await page.waitForSelector(`#cr-${rootThread.id} .cr-message-body`);
      expect(
        await page.locator(`#cr-${rootThread.id}`).innerText(),
      ).toContain(ROOT_COMMENT);
      expect(
        await page.locator(`#cr-${rootThread.id} header`).innerText(),
      ).toContain("new lines 2–2");

      if (!(await page.locator("#cr-snapshot").isVisible())) await page.locator(".cr-snapshot-history summary").click();
      await page.locator("#cr-snapshot").selectOption(unchangedSnapshotId);
      await page.waitForFunction(
        (snapshotId) =>
          (document.querySelector("#cr-snapshot") as HTMLSelectElement | null)
            ?.value === snapshotId,
        unchangedSnapshotId,
      );
      await page.waitForFunction(
        () =>
          document.querySelector(".cr-file-header .cr-muted")?.textContent?.includes(
            "Index → saved worktree",
          ) === true,
      );

      const problems: string[] = [];
      const noteUnchangedPane = async (phase: string) => {
        const sourceText = await page.locator(".cr-source").innerText();
        const lineCount = await page.locator(".cr-line").count();
        const lineCommentCount = await page
          .locator('.cr-source [data-action="line-comment"]')
          .count();
        const expandCount = await page
          .locator('.cr-source [data-action="expand-context"]')
          .count();
        if (!sourceText.includes("No changes"))
          problems.push(
            `${phase}: unchanged snapshot did not show a No changes state. Saw ${JSON.stringify(sourceText)}.`,
          );
        if (lineCount !== 0)
          problems.push(
            `${phase}: unchanged snapshot rendered ${lineCount} line rows instead of 0.`,
          );
        if (lineCommentCount !== 0)
          problems.push(
            `${phase}: unchanged snapshot exposed ${lineCommentCount} line comment controls for invented line changes.`,
          );
        if (expandCount !== 0)
          problems.push(
            `${phase}: unchanged snapshot offered ${expandCount} expand-context controls for unchanged lines.`,
          );
      };

      await noteUnchangedPane("before file-level guidance");
      await page.locator('[data-action="file-comment"]').click();
      await page.locator("#cr-body").fill(FILE_COMMENT);
      await page.waitForTimeout(650);
      await page.locator('[data-action="post"]').click();
      await page.waitForFunction(
        () =>
          document.querySelector(".cr-status")?.textContent?.includes(
            "Comment saved",
          ) === true,
      );

      const threads = harness.store.listThreads(harness.ctx, created.reviewId);
      const fileThreadRow = threads.find((thread) =>
        harness.store.getThread(harness.ctx, thread.id).anchor.scope === "file"
      );
      expect(fileThreadRow).toBeTruthy();
      const fileThread = harness.store.getThread(
        harness.ctx,
        fileThreadRow!.id,
      );
      expect(fileThread.anchor).toMatchObject({
        snapshotFileId: unchangedFileId,
        scope: "file",
        side: "new",
        startLine: null,
        endLine: null,
      });
      expect(await page.locator(`#cr-${fileThread.id} [data-action="expand"]`).getAttribute("aria-expanded")).toBe("true");
      await page.waitForSelector(`#cr-${fileThread.id} .cr-message-body`);
      const fileThreadText = await page.locator(`#cr-${fileThread.id}`).innerText();
      if (!fileThreadText.includes("Whole file"))
        problems.push("file-level guidance did not stay attached to the whole-file empty diff view.");
      if (!fileThreadText.includes(FILE_COMMENT))
        problems.push("file-level guidance body was not visible after posting in the unchanged view.");
      await noteUnchangedPane("after file-level guidance");

      expectRepoUnchanged(harness.repoState(), baseline);
      expect(errors).toEqual([]);
      if (problems.length)
        throw Error(problems.join("\n"));
    } finally {
      await browser?.close();
      harness.cleanup();
    }
  },
  45_000,
);
