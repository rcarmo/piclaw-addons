import { expect, test } from "bun:test";
import { chromium } from "playwright";
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

import {
  ReviewError,
  type LocalTarget,
  type ReviewIdentity,
  type SourceCapture,
} from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";

const PATH_PREFIX = "piclaw://addon/code-review/";
const MAIN_BODY = "Selected main-thread guidance";
const UTIL_BODY = "Selected util-thread guidance";
const OTHER_BODY = "Unselected thread that must stay untouched";
const DRAFT_BODY = "Private draft that must never be dispatched";
const SUMMARY = "Check the selected concerns together.";

let harnessSerial = 0;

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

function createHarness(name: string) {
  const serial = `${name}-${++harnessSerial}`;
  const root = mkdtempSync(join(tmpdir(), `review-batch-pane-${serial}-`));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "main.ts"),
    "export const main = true;\nexport function keepMain() {\n  return 'main';\n}\n",
  );
  writeFileSync(
    join(workspace, "src", "util.ts"),
    "export function utilFallback() {\n  return 'util';\n}\n",
  );

  const store = new ReviewService(join(root, "review.db"));
  let request = 0;

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
  const mutation = (expectedVersion?: number, requestId?: string) => ({
    requestId: requestId ?? `req:${serial}:${++request}`,
    expectedVersion,
  });
  const capture = (files: SourceCapture["files"]): SourceCapture => ({
    workspaceId: operator.workspaceId!,
    worktreeId: `worktree:${serial}`,
    mode: "source",
    base: null,
    head: null,
    capturedAt: new Date().toISOString(),
    files,
  });

  const review = store.createFromCapture(
    operator,
    {
      title: "Batch pane acceptance",
      focusPath: "src/main.ts",
      target,
    },
    capture([
      {
        oldPath: null,
        newPath: "src/main.ts",
        change: "source",
        oldText: null,
        newText:
          "export const main = true;\nexport function keepMain() {\n  return 'main';\n}\n",
        fileIdentity: `inode:main:${serial}`,
      },
      {
        oldPath: null,
        newPath: "src/util.ts",
        change: "source",
        oldText: null,
        newText: "export function utilFallback() {\n  return 'util';\n}\n",
        fileIdentity: `inode:util:${serial}`,
      },
    ]),
    mutation(),
  );

  const reviewId = review.reviewId;
  const mainFileId = review.files[0]!;
  const utilFileId = review.files[1]!;
  const mainThread = store.createThread(
    operator,
    reviewId,
    {
      fileId: mainFileId,
      side: "source",
      range: { startLine: 1, endLine: 1 },
      body: MAIN_BODY,
    },
    mutation(),
  );
  const utilThread = store.createThread(
    operator,
    reviewId,
    {
      fileId: utilFileId,
      side: "source",
      range: { startLine: 1, endLine: 1 },
      body: UTIL_BODY,
    },
    mutation(),
  );
  const otherThread = store.createThread(
    operator,
    reviewId,
    {
      fileId: mainFileId,
      side: "source",
      range: { startLine: 2, endLine: 2 },
      body: OTHER_BODY,
    },
    mutation(),
  );
  store.saveDraft(
    operator,
    reviewId,
    { threadId: mainThread.threadId, body: DRAFT_BODY },
    mutation(),
  );

  const queueCalls: QueueCall[] = [];
  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: operator.ownerId,
    actorId: operator.actorId,
    kind: "operator",
    workspaceRoot: workspace,
    workspaceId: operator.workspaceId!,
    async listTargets() {
      return [hostTarget];
    },
    async resolveTarget(input) {
      return (
        (input.chatJid === undefined || input.chatJid === hostTarget.chatJid) &&
        (input.agentName === undefined ||
          input.agentName === hostTarget.agentName) &&
        (input.incarnation === undefined ||
          input.incarnation === hostTarget.incarnation)
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
  const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:calc(100% - 40px)}</style></head><body><button id="open-review">Open review</button><main id="pane"></main><script>let pane;window.__codeReviewReady=false;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};document.getElementById('open-review').onclick=()=>window.__piclaw_web.openPane({path:${JSON.stringify(PATH_PREFIX + reviewId)}});</script><script type="module" src="/web/index.ts"></script></body></html>`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/")
        return new Response(shell, {
          headers: { "Content-Type": "text/html" },
        });
      if (
        ["/web/index.ts", "/web/api.ts", "/web/pane.ts", "/web/styles.ts"].includes(
          path,
        )
      )
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
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME"])
      if (process.env[key]) env[key] = process.env[key]!;
    const browser = await chromium.launch({
      headless: true,
      executablePath: browserExecutable(),
      args: ["--no-sandbox"],
      env,
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

  const openReview = async (page: any) => {
    await page.locator("#open-review").click();
    await page.waitForSelector(".cr-line");
    await page.waitForFunction(
      () =>
        document.querySelector(".cr-file-header strong")?.textContent ===
        "src/main.ts",
    );
  };

  const cleanup = async () => {
    server.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  };

  return {
    store,
    operator,
    target,
    reviewId,
    mainFileId,
    utilFileId,
    mainThreadId: mainThread.threadId,
    utilThreadId: utilThread.threadId,
    otherThreadId: otherThread.threadId,
    queueCalls,
    mutation,
    launchPage,
    waitForShell,
    openReview,
    cleanup,
  };
}

async function selectAcrossFiles(
  page: any,
  input: { mainThreadId: string; utilThreadId: string },
) {
  await page.waitForSelector(`[data-pick="${input.mainThreadId}"]`);
  await page.locator(`[data-pick="${input.mainThreadId}"]`).check();
  expect(
    await page.locator(".cr-toolbar [data-action=send]").textContent(),
  ).toContain("Send to agent (1)");

  await page.locator(".cr-toolbar [data-action=files]").click();
  await page.waitForSelector(".cr-files.open");
  await page
    .locator(".cr-files [data-action=file]")
    .filter({ hasText: "src/util.ts" })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".cr-file-header strong")?.textContent ===
      "src/util.ts",
  );
  await page.waitForSelector(`[data-pick="${input.utilThreadId}"]`);
  await page.locator(`[data-pick="${input.utilThreadId}"]`).check();
  expect(
    await page.locator(".cr-toolbar [data-action=send]").textContent(),
  ).toContain("Send to agent (2)");
}

test("RC-3 mixed-target selection shows the mock's explicit reassignment warning without sending", async () => {
  const harness = createHarness("mixed-target");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const otherTarget = { chatId: "web:reviewer", incarnation: "reviewer-lifetime", label: "Reviewer" };
    harness.store.reassign(harness.operator, harness.utilThreadId, otherTarget, harness.mutation(1));
    const launched = await harness.launchPage();
    browser = launched.browser;
    const { page, errors } = launched;
    await harness.waitForShell(page);
    await harness.openReview(page);
    await selectAcrossFiles(page, harness);
    await page.locator(".cr-toolbar [data-action=send]").click();
    await page.waitForSelector(".cr-target-warning");
    expect(await page.locator(".cr-target-warning").innerText()).toContain("Reassign explicitly or send separate batches");
    expect(await page.locator("[data-action=confirm-send]").isDisabled()).toBe(true);
    expect(await page.locator("[data-action=confirm-send]").getAttribute("title")).toContain("different bound target");
    expect(harness.queueCalls).toHaveLength(0);
    expect(harness.store.getThread(harness.operator, harness.utilThreadId).target).toEqual(otherTarget);
    await page.locator(`.cr-drawer [data-pick="${harness.utilThreadId}"]`).uncheck();
    expect(await page.locator(".cr-target-warning").count()).toBe(0);
    await page.waitForFunction(() => !(document.querySelector("[data-action=confirm-send]") as HTMLButtonElement)?.disabled);
    // An older automatic preview must not overwrite a newer selection or
    // reopen a drawer dismissed while the response was held.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const held = new Promise<void>((resolve) => { started = resolve; });
    let first = true;
    await page.route("**/agent/addons/api/code-review/action", async (route) => {
      const payload = JSON.parse(route.request().postData() || "{}");
      if (payload.action === "preview" && first) { first = false; started(); await gate; }
      await route.continue();
    });
    try {
      await page.locator(`.cr-drawer [data-pick="${harness.otherThreadId}"]`).check();
      await held;
      expect(await page.locator("[data-action=confirm-send]").isDisabled()).toBe(true);
      await page.locator(`.cr-drawer [data-pick="${harness.otherThreadId}"]`).uncheck();
      await page.waitForFunction(() => !(document.querySelector("[data-action=confirm-send]") as HTMLButtonElement)?.disabled);
      expect(await page.locator(".cr-send-preview li").count()).toBe(1);
      await page.locator("button[data-action=close-drawer]").click();
      release();
      await page.waitForTimeout(150);
      expect(await page.locator(".cr-drawer").count()).toBe(0);
      expect(harness.queueCalls).toHaveLength(0);
    } finally { release(); await page.unroute("**/agent/addons/api/code-review/action"); }
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await harness.cleanup(); }
}, 45_000);

test(
  "CR-104/109 browser batch preview stays inert, queues one ordered dispatch, and reload does not re-enqueue",
  async () => {
    const harness = createHarness("accept");
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const launched = await harness.launchPage();
      browser = launched.browser;
      const { page, errors } = launched;

      await harness.waitForShell(page);
      await harness.openReview(page);
      await selectAcrossFiles(page, {
        mainThreadId: harness.mainThreadId,
        utilThreadId: harness.utilThreadId,
      });

      await page.locator(".cr-toolbar [data-action=send]").click();
      await page.waitForSelector(".cr-drawer");
      await page.locator("#cr-summary").fill(SUMMARY);

      expect(await page.locator(".cr-drawer .cr-drawer-item").count()).toBe(3);
      expect(
        await page.locator('.cr-drawer input[data-pick]:checked').count(),
      ).toBe(2);
      expect(
        await page
          .locator(`.cr-drawer [data-pick="${harness.mainThreadId}"]`)
          .isChecked(),
      ).toBe(true);
      expect(
        await page
          .locator(`.cr-drawer [data-pick="${harness.utilThreadId}"]`)
          .isChecked(),
      ).toBe(true);
      expect(
        await page
          .locator(`.cr-drawer [data-pick="${harness.otherThreadId}"]`)
          .isChecked(),
      ).toBe(false);
      expect(await page.locator("#cr-summary").inputValue()).toBe(SUMMARY);
      await page.locator(".cr-preview-details summary").click();
      const previewItems = page.locator(".cr-send-preview li");
      expect(await previewItems.count()).toBe(2);
      expect(await previewItems.first().getAttribute("data-preview-thread")).toBe(harness.mainThreadId);
      expect(await previewItems.nth(1).getAttribute("data-preview-thread")).toBe(harness.utilThreadId);
      const firstPreview = await previewItems.first().innerText();
      const secondPreview = await previewItems.nth(1).innerText();
      expect(firstPreview).toContain("Guidance v1 · assignment 1");
      expect(firstPreview).toContain(harness.mainFileId);
      expect(secondPreview).toContain("Guidance v1 · assignment 1");
      expect(secondPreview).toContain(harness.utilFileId);
      expect(await page.locator(".cr-drawer p").last().textContent()).toContain(
        "Queue to Implementation behind current work. No interruption.",
      );
      expect(harness.queueCalls).toHaveLength(0);
      expect(harness.store.listDispatches(harness.operator, harness.reviewId)).toEqual(
        [],
      );

      await page.locator("[data-action=confirm-send]").click();
      await page.waitForFunction(() =>
        document.querySelector(".cr-status")?.textContent?.includes("accepted"),
      );

      expect(harness.queueCalls).toHaveLength(1);
      expect(harness.queueCalls[0]).toMatchObject({
        mode: "queue",
        target: {
          chatJid: harness.target.chatId,
          incarnation: harness.target.incarnation,
        },
      });
      expect(harness.queueCalls[0]!.content).not.toContain(OTHER_BODY);
      expect(harness.queueCalls[0]!.content).not.toContain(DRAFT_BODY);

      const rows = harness.store.listDispatches(harness.operator, harness.reviewId);
      expect(rows).toHaveLength(1);
      const dispatch = harness.store.inspectDispatch(
        harness.operator,
        rows[0]!.id,
      );
      expect(dispatch.items.map((item: any) => item.thread_id)).toEqual([
        harness.mainThreadId,
        harness.utilThreadId,
      ]);
      expect(
        dispatch.items.map((item: any) => item.snapshot_file_id),
      ).toEqual([harness.mainFileId, harness.utilFileId]);
      expect(dispatch.attempts).toEqual([
        expect.objectContaining({ number: 1, state: "accepted", host_row_id: 100 }),
      ]);
      expect(JSON.stringify(dispatch)).not.toContain(OTHER_BODY);
      expect(JSON.stringify(dispatch)).not.toContain(DRAFT_BODY);

      await page.reload();
      await harness.waitForShell(page);
      await harness.openReview(page);
      await page.waitForTimeout(200);
      expect(harness.queueCalls).toHaveLength(1);
      expect(
        harness.store.inspectDispatch(harness.operator, rows[0]!.id).attempts,
      ).toEqual([
        expect.objectContaining({ number: 1, state: "accepted", host_row_id: 100 }),
      ]);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await harness.cleanup();
    }
  },
  45_000,
);

test(
  "CR-106 in-flight preview cannot reopen a drawer after the selection changes",
  async () => {
    const harness = createHarness("in-flight");
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let release: (() => void) | undefined;
    try {
      const launched = await harness.launchPage();
      browser = launched.browser;
      const { page, errors } = launched;
      await harness.waitForShell(page);
      await harness.openReview(page);
      await selectAcrossFiles(page, {
        mainThreadId: harness.mainThreadId,
        utilThreadId: harness.utilThreadId,
      });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let intercepted!: () => void;
      const previewStarted = new Promise<void>((resolve) => { intercepted = resolve; });
      await page.route("**/agent/addons/api/code-review/action", async (route) => {
        const body = JSON.parse(route.request().postData() || "{}");
        if (body.action === "preview") {
          intercepted();
          await gate;
        }
        await route.continue();
      });
      await page.locator(".cr-toolbar [data-action=send]").click();
      await previewStarted;
      await page.locator(`[data-pick="${harness.utilThreadId}"]`).uncheck();
      expect(await page.locator(".cr-toolbar [data-action=send]").textContent()).toContain("(1)");
      release?.();
      await page.waitForTimeout(150);
      expect(await page.locator(".cr-drawer").count()).toBe(0);
      expect(harness.store.listDispatches(harness.operator, harness.reviewId)).toEqual([]);
      expect(harness.queueCalls).toHaveLength(0);
      await page.unroute("**/agent/addons/api/code-review/action");
      await page.locator(".cr-toolbar [data-action=send]").click();
      await page.locator(".cr-preview-details summary").click();
      await page.waitForSelector(".cr-send-preview li");
      expect(await page.locator(".cr-send-preview li").count()).toBe(1);
      expect(await page.locator(".cr-send-preview li").first().getAttribute("data-preview-thread")).toBe(harness.mainThreadId);
      expect(errors).toEqual([]);
    } finally {
      release?.();
      await browser?.close();
      await harness.cleanup();
    }
  },
  45_000,
);

test(
  "CR-106 slice: a changed preview is rejected before enqueue and the drawer keeps the conflict bounded",
  async () => {
    const harness = createHarness("conflict");
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const launched = await harness.launchPage();
      browser = launched.browser;
      const { page, errors } = launched;

      await harness.waitForShell(page);
      await harness.openReview(page);
      await selectAcrossFiles(page, {
        mainThreadId: harness.mainThreadId,
        utilThreadId: harness.utilThreadId,
      });

      await page.locator(".cr-toolbar [data-action=send]").click();
      await page.waitForSelector(".cr-drawer");
      await page.locator("#cr-summary").fill(SUMMARY);
      expect(harness.queueCalls).toHaveLength(0);
      expect(harness.store.listDispatches(harness.operator, harness.reviewId)).toEqual(
        [],
      );

      harness.store.reply(
        harness.operator,
        harness.utilThreadId,
        "Edited after preview",
        harness.mutation(1),
      );

      await page.locator("[data-action=confirm-send]").click();
      await page.waitForFunction(() =>
        document
          .querySelector(".cr-status")
          ?.textContent?.includes("Guidance changed. Review the updated selection"),
      );

      expect(harness.queueCalls).toHaveLength(0);
      expect(harness.store.listDispatches(harness.operator, harness.reviewId)).toEqual(
        [],
      );
      expect(await page.locator(".cr-drawer").count()).toBe(1);
      expect(
        await page.locator('.cr-drawer input[data-pick]:checked').count(),
      ).toBe(2);
      expect(
        await page
          .locator(`.cr-drawer [data-pick="${harness.mainThreadId}"]`)
          .isChecked(),
      ).toBe(true);
      expect(
        await page
          .locator(`.cr-drawer [data-pick="${harness.utilThreadId}"]`)
          .isChecked(),
      ).toBe(true);
      expect(
        await page
          .locator(`.cr-drawer [data-pick="${harness.otherThreadId}"]`)
          .isChecked(),
      ).toBe(false);
      expect(await page.locator("#cr-summary").inputValue()).toBe(SUMMARY);
      expect(await page.locator(".cr-status").textContent()).toContain(
        "Guidance changed. Review the updated selection",
      );
      expect(await page.locator(".cr-send-preview li").count()).toBe(2);
      await page.locator(".cr-preview-details summary").click();
      expect(await page.locator(".cr-send-preview li").nth(1).innerText()).toContain("Guidance v2");
      expect(await page.locator('[data-action="confirm-send"]').isDisabled()).toBe(false);
      expect(await page.locator('[data-action="refresh-send-preview"]').count()).toBe(0);
      expect(await page.locator('.cr-send-preview li').nth(1).innerText()).toContain(harness.utilFileId);
      await page.locator(`.cr-drawer [data-pick="${harness.otherThreadId}"]`).check();
      await page.waitForFunction(() => document.querySelectorAll('.cr-send-preview li').length === 3);
      expect(await page.locator('.cr-send-preview li').nth(2).getAttribute('data-preview-thread')).toBe(harness.otherThreadId);
      expect(await page.locator('[data-action="confirm-send"]').isDisabled()).toBe(false);
      expect(harness.store.listDispatches(harness.operator, harness.reviewId)).toEqual([]);
      expect(harness.queueCalls).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await harness.cleanup();
    }
  },
  45_000,
);
