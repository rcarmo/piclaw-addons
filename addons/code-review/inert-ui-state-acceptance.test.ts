import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

import { ReviewError, type LocalTarget, type ReviewIdentity } from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";
import { SourceReader } from "./source.js";

const PATH_PREFIX = "piclaw://addon/code-review/";
const LONG_SEGMENT = "wrap_segment_".repeat(12);

let harnessSerial = 0;

type QueueCall = {
  target: { chatJid: string; incarnation: string };
  content: string;
  mode: "queue";
};

type PersistedSnapshot = {
  counts: {
    drafts: number;
    messages: number;
    dispatches: number;
    dispatchItems: number;
    attempts: number;
    events: number;
    receipts: number;
  };
  review: unknown;
  threads: unknown[];
  events: unknown[];
  receipts: unknown[];
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

function buildFileText(label: "main" | "util", phase: "base" | "staged") {
  const title = label === "main" ? "Main" : "Util";
  const lines: string[] = [];
  for (let line = 1; line <= 96; line++) {
    if (line === 8) {
      lines.push(`export const ${label}Review = "${phase}-${title}";`);
      continue;
    }
    if (line === 44) {
      lines.push(
        `export const ${label}Wrap = "${phase}:${LONG_SEGMENT}:${title}";`,
      );
      continue;
    }
    if (line === 73) {
      lines.push(
        `export function ${label}Checkpoint${line}() { return "${phase}-${label}-${line}"; }`,
      );
      continue;
    }
    lines.push(`export const ${label}_${String(line).padStart(2, "0")} = ${line};`);
  }
  return lines.join("\n") + "\n";
}

function count(store: ReviewService, sql: string, ...params: string[]) {
  return store.database.get<{ n: number }>(sql, ...params)?.n ?? 0;
}

function snapshotState(input: {
  store: ReviewService;
  operator: ReviewIdentity;
  reviewId: string;
  threadIds: string[];
}): PersistedSnapshot {
  return {
    counts: {
      drafts: count(input.store, "SELECT COUNT(*) AS n FROM drafts WHERE review_id=?", input.reviewId),
      messages: count(input.store, "SELECT COUNT(*) AS n FROM messages WHERE review_id=?", input.reviewId),
      dispatches: count(input.store, "SELECT COUNT(*) AS n FROM dispatches WHERE review_id=?", input.reviewId),
      dispatchItems: count(
        input.store,
        "SELECT COUNT(*) AS n FROM dispatch_items WHERE review_id=?",
        input.reviewId,
      ),
      attempts: count(
        input.store,
        "SELECT COUNT(*) AS n FROM attempts WHERE dispatch_id IN (SELECT id FROM dispatches WHERE review_id=?)",
        input.reviewId,
      ),
      events: count(input.store, "SELECT COUNT(*) AS n FROM events WHERE review_id=?", input.reviewId),
      receipts: count(input.store, "SELECT COUNT(*) AS n FROM request_receipts"),
    },
    review: input.store.getReview(input.operator, input.reviewId),
    threads: input.threadIds.map((threadId) => input.store.getThread(input.operator, threadId)),
    events: input.store.database.all(
      "SELECT review_id,thread_id,dispatch_id,actor_id,kind,data_json,created_at FROM events WHERE review_id=? ORDER BY cursor",
      input.reviewId,
    ),
    receipts: input.store.database.all(
      "SELECT owner_id,actor_id,request_id,action,payload_hash,result_json,created_at FROM request_receipts ORDER BY owner_id,actor_id,request_id",
    ),
  };
}

async function waitForShell(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(
    () =>
      (window as any).__codeReviewReady === true &&
      document.querySelector("#open-review") !== null,
  );
}

async function openReview(page: Page) {
  await page.locator("#open-review").click();
  await page.waitForSelector(".cr-line");
  await page.waitForFunction(
    () =>
      document.querySelector(".cr-file-header strong")?.textContent ===
      "src/main.ts",
  );
}

async function openFiles(page: Page) {
  const open = await page
    .locator(".cr-files")
    .evaluate((element) => element.classList.contains("open"));
  if (!open) {
    await page.locator(".cr-toolbar [data-action=files]").click();
    await page.waitForSelector(".cr-files.open");
  }
}

async function openFile(page: Page, path: string) {
  await openFiles(page);
  await page
    .locator(".cr-files [data-action=file]")
    .filter({ hasText: path })
    .click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".cr-file-header strong")?.textContent === expected,
    path,
  );
}

async function clickMenuAction(page: Page, action: string) {
  await page.locator(".cr-toolbar [data-action=options]").click();
  await page.waitForSelector(`.cr-menu [data-action="${action}"]`);
  await page.locator(`.cr-menu [data-action="${action}"]`).click();
}

async function launchPage() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable(),
    args: ["--no-sandbox"],
    env: browserEnv(),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { browser, page, errors };
}

async function createHarness(name: string) {
  const serial = `${name}-${++harnessSerial}`;
  const root = mkdtempSync(join(tmpdir(), `review-inert-ui-${serial}-`));
  const repoDir = join(root, "repo");
  mkdirSync(join(repoDir, "src"), { recursive: true });

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

  writeFileSync(join(repoDir, "src", "main.ts"), buildFileText("main", "base"));
  writeFileSync(join(repoDir, "src", "util.ts"), buildFileText("util", "base"));
  git("add", "src/main.ts", "src/util.ts");
  git("commit", "-qm", "base");

  writeFileSync(join(repoDir, "src", "main.ts"), buildFileText("main", "staged"));
  writeFileSync(join(repoDir, "src", "util.ts"), buildFileText("util", "staged"));
  git("add", "src/main.ts", "src/util.ts");

  const reader = new SourceReader(repoDir, `workspace:${serial}`);
  const capture = await reader.capture({ path: "src", mode: "staged" });
  expect(capture.files.map((file) => file.newPath ?? file.oldPath)).toEqual([
    "src/main.ts",
    "src/util.ts",
  ]);

  const store = new ReviewService(join(root, "review.db"));
  const operator: ReviewIdentity = {
    ownerId: `owner:${serial}`,
    actorId: `operator:${serial}`,
    kind: "operator",
    workspaceId: `workspace:${serial}`,
  };
  const target: LocalTarget = {
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
  const mutation = (expectedVersion?: number, requestId?: string) => ({
    requestId: requestId ?? `req:${serial}:${++request}`,
    expectedVersion,
  });
  const created = store.createFromCapture(
    operator,
    {
      title: "CR-184 inert UI state",
      focusPath: "src/main.ts",
      target,
    },
    capture,
    mutation(),
  );
  const files = store.snapshotFiles(operator, created.reviewId, created.snapshotId);
  const mainFileId = files.find((file) => file.new_path === "src/main.ts")?.id;
  const utilFileId = files.find((file) => file.new_path === "src/util.ts")?.id;
  if (!mainFileId || !utilFileId) throw Error("Fixture capture did not produce both review files.");

  const mainThread = store.createThread(
    operator,
    created.reviewId,
    {
      fileId: mainFileId,
      side: "new",
      range: { startLine: 8, endLine: 8 },
      body: "Keep the staged main review label explicit.",
    },
    mutation(),
  );
  store.reply(
    operator,
    mainThread.threadId,
    "Published follow-up for the main diff thread.",
    mutation(1),
  );
  const utilThread = store.createThread(
    operator,
    created.reviewId,
    {
      fileId: utilFileId,
      side: "new",
      range: { startLine: 44, endLine: 44 },
      body: "Inspect the long util diff line without treating it as approval.",
    },
    mutation(),
  );

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

  const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:calc(100% - 40px)}</style></head><body><button id="open-review">Open review</button><main id="pane"></main><script>let pane;window.__codeReviewReady=false;window.__piclaw_web={workspaceActionsVersion:1,registerPane(entry){pane=entry;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};document.getElementById('open-review').onclick=()=>window.__piclaw_web.openPane({path:${JSON.stringify(PATH_PREFIX + created.reviewId)}});</script><script type="module" src="/web/index.ts"></script></body></html>`;
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

  return {
    store,
    operator,
    reviewId: created.reviewId,
    mainThreadId: mainThread.threadId,
    utilThreadId: utilThread.threadId,
    queueCalls,
    server,
    launchPage,
    cleanup() {
      server.stop(true);
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test(
  "CR-184 slice: browse/layout/selection/send-preview UI stays inert and persists no review workflow state",
  async () => {
    const harness = await createHarness("cr184");
    const before = snapshotState({
      store: harness.store,
      operator: harness.operator,
      reviewId: harness.reviewId,
      threadIds: [harness.mainThreadId, harness.utilThreadId],
    });
    let browser: Browser | undefined;
    try {
      expect(
        harness.store.database.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('viewed','read_progress','read-progress') ORDER BY name",
        ),
      ).toEqual([]);
      expect(harness.store.listDispatches(harness.operator, harness.reviewId)).toEqual([]);

      const launched = await harness.launchPage();
      browser = launched.browser;
      const { page, errors } = launched;

      await waitForShell(page, harness.server.url.href);
      await openReview(page);
      await page.waitForSelector(`[data-pick="${harness.mainThreadId}"]`);

      const uiTextBefore = await page.locator(".cr-pane").innerText();
      expect(uiTextBefore).not.toContain("Viewed");
      expect(uiTextBefore).not.toContain("read-progress");
      expect(await page.locator("#viewed,.cr-viewed,[data-read-progress]").count()).toBe(0);

      await clickMenuAction(page, "wrap");
      expect(await page.locator(".cr-source.wrap").count()).toBe(1);

      await clickMenuAction(page, "layout");
      expect(await page.locator(".cr-pair").count()).toBeGreaterThan(0);
      await page.locator(".cr-expand").first().click();

      expect(
        await page.locator(".cr-source").evaluate((element) => {
          element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 40);
          return element.scrollTop;
        }),
      ).toBeGreaterThan(0);

      await page.locator(`[data-pick="${harness.mainThreadId}"]`).check();
      expect(
        await page.locator(".cr-toolbar [data-action=send]").textContent(),
      ).toContain("(1)");

      await openFile(page, "src/util.ts");
      await page.waitForSelector(`[data-pick="${harness.utilThreadId}"]`);
      await page.locator('[data-action="select-line"][data-side="new"][data-line="44"]').click();
      await page.locator('[data-action="select-line"][data-side="new"][data-line="45"]').click();
      expect(await page.locator(".cr-selection").textContent()).toContain("new lines 44–45");
      expect(
        await page.locator(".cr-source").evaluate((element) => {
          element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 20);
          return element.scrollTop;
        }),
      ).toBeGreaterThan(0);

      await page.locator(`[data-pick="${harness.utilThreadId}"]`).check();
      expect(
        await page.locator(".cr-toolbar [data-action=send]").textContent(),
      ).toContain("(2)");
      expect(harness.queueCalls).toEqual([]);

      await page.locator(".cr-toolbar [data-action=send]").click();
      await page.waitForSelector(".cr-drawer");
      expect(await page.locator(".cr-send-preview li").count()).toBe(2);
      expect(
        await page.locator(".cr-send-preview li").first().getAttribute("data-preview-thread"),
      ).toBe(harness.mainThreadId);
      expect(
        await page.locator(".cr-send-preview li").nth(1).getAttribute("data-preview-thread"),
      ).toBe(harness.utilThreadId);
      expect(await page.locator(".cr-status").count()).toBe(0);
      expect(harness.queueCalls).toEqual([]);
      expect(harness.store.listDispatches(harness.operator, harness.reviewId)).toEqual([]);

      await page.locator(".cr-drawer [data-action=close-drawer]").click();
      expect(await page.locator(".cr-drawer").count()).toBe(0);
      expect(await page.locator(".cr-status").count()).toBe(0);
      expect(harness.queueCalls).toEqual([]);
      expect(harness.store.listDispatches(harness.operator, harness.reviewId)).toEqual([]);

      expect(
        snapshotState({
          store: harness.store,
          operator: harness.operator,
          reviewId: harness.reviewId,
          threadIds: [harness.mainThreadId, harness.utilThreadId],
        }),
      ).toEqual(before);

      await page.reload();
      await waitForShell(page, harness.server.url.href);
      await openReview(page);
      await page.waitForSelector(`[data-pick="${harness.mainThreadId}"]`);

      expect(
        snapshotState({
          store: harness.store,
          operator: harness.operator,
          reviewId: harness.reviewId,
          threadIds: [harness.mainThreadId, harness.utilThreadId],
        }),
      ).toEqual(before);
      expect(await page.locator(".cr-selection").count()).toBe(0);
      expect(await page.locator('.cr-thread input[data-pick]:checked').count()).toBe(0);
      expect(await page.locator(".cr-toolbar [data-action=send]").isDisabled()).toBe(true);
      expect(await page.locator(".cr-status").count()).toBe(0);
      expect(await page.locator("#viewed,.cr-viewed,[data-read-progress]").count()).toBe(0);
      expect(harness.queueCalls).toEqual([]);
      expect(harness.store.listDispatches(harness.operator, harness.reviewId)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      harness.cleanup();
    }
  },
  45_000,
);
