import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";

type QueueOutcome =
  | { kind: "accepted"; rowId: number | null }
  | { kind: "rejected"; code: string }
  | { kind: "unknown"; message: string };

function createHarness(name: string) {
  const root = mkdtempSync(join(tmpdir(), `review-receipts-${name}-`));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(
    join(workspace, "sample.ts"),
    "export function validate(name: string) {\n  return name.trim();\n}\n",
  );

  const store = new ReviewService(join(root, "review.db"));
  const who = {
    ownerId: `owner:${name}`,
    actorId: `operator:${name}`,
    kind: "operator" as const,
    workspaceId: `workspace:${name}`,
  };
  const target = {
    chatJid: "web:worker",
    incarnation: "branch-1",
    label: "Implementation",
    agentName: "implementation",
    active: true,
  };
  const outcomes: QueueOutcome[] = [];
  const queueCalls: Array<{
    target: { chatJid: string; incarnation: string };
    content: string;
    mode: "queue";
  }> = [];

  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: who.ownerId,
    actorId: who.actorId,
    kind: "operator",
    workspaceRoot: workspace,
    workspaceId: who.workspaceId,
    async listTargets() {
      return [target];
    },
    async resolveTarget(input) {
      return (
        (input.chatJid === undefined || input.chatJid === target.chatJid) &&
        (input.agentName === undefined || input.agentName === target.agentName) &&
        (input.incarnation === undefined ||
          input.incarnation === target.incarnation)
      )
        ? target
        : null;
    },
    async enqueue(input) {
      queueCalls.push(input);
      const next = outcomes.shift();
      if (!next) return { status: "accepted" as const, rowId: queueCalls.length };
      if (next.kind === "accepted")
        return { status: "accepted" as const, rowId: next.rowId };
      if (next.kind === "rejected")
        throw Object.assign(Error("queue rejected"), {
          delivery: "rejected",
          code: next.code,
        });
      throw Error(next.message);
    },
  };

  const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:calc(100% - 40px)}</style></head><body><button id="review">Review file</button><main id="pane"></main><script>const handlers=[];let pane;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p},registerWorkspaceAction(a){handlers.push(a)},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};document.getElementById('review').onclick=()=>handlers[0].run({path:'sample.ts',type:'file',name:'sample.ts',chatJid:'web:worker'});</script><script type="module" src="/web/index.ts"></script></body></html>`;
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
          return Response.json({
            ok: false,
            error: { message: (error as Error).message },
          });
        }
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const seedReview = async (
    requestPrefix: string,
    body: string,
    outcome: QueueOutcome,
  ) => {
    outcomes.push(outcome);
    const created: any = await reviewAction(
      ctx,
      "create",
      {
        path: "sample.ts",
        title: "sample.ts",
        target: { chatId: target.chatJid, incarnation: target.incarnation },
        requestId: `${requestPrefix}-create`,
      },
      store,
    );
    const thread: any = await reviewAction(
      ctx,
      "comment",
      {
        reviewId: created.reviewId,
        fileId: created.files[0],
        side: "source",
        range: { startLine: 2, endLine: 2 },
        body,
        requestId: `${requestPrefix}-comment`,
      },
      store,
    );
    const dispatch: any = await reviewAction(
      ctx,
      "send",
      {
        reviewId: created.reviewId,
        target: { chatId: target.chatJid, incarnation: target.incarnation },
        items: [{ threadId: thread.threadId, version: thread.version }],
        requestId: `${requestPrefix}-send`,
      },
      store,
    );
    return {
      reviewId: created.reviewId as string,
      fileId: created.files[0] as string,
      threadId: thread.threadId as string,
      body,
      dispatch,
    };
  };

  const launchPage = async (onDialog: (message: string) => string | true) => {
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME"])
      if (process.env[key]) env[key] = process.env[key]!;
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PICLAW_REVIEW_TEST_BROWSER || undefined,
      args: ["--no-sandbox"],
      env,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", async (dialog) => {
      const response = onDialog(dialog.message());
      await dialog.accept(response === true ? undefined : response);
    });
    return { browser, page, errors };
  };

  const waitForShell = async (page: any) => {
    await page.goto(server.url.href);
    await page.waitForFunction(
      () =>
        !!(window as any).__piclaw_web?.workspaceActionsVersion &&
        document.querySelector("#review") !== null,
    );
  };

  const openSeededReview = async (page: any) => {
    await page.locator("#review").click();
    await page.waitForSelector(".cr-line");
    await page.waitForSelector(".cr-thread");
  };

  const openReceipts = async (page: any) => {
    await page.locator(".cr-toolbar [data-action=options]").click();
    await page.locator(".cr-menu [data-action=receipts]").click();
    await page.waitForSelector(".cr-receipts");
  };

  const pushOutcome = (outcome: QueueOutcome) => {
    outcomes.push(outcome);
  };

  const cleanup = async () => {
    server.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  };

  return {
    root,
    who,
    target,
    store,
    queueCalls,
    seedReview,
    pushOutcome,
    launchPage,
    waitForShell,
    openSeededReview,
    openReceipts,
    cleanup,
  };
}

test("CR-040/098 browser retry keeps one dispatch, creates attempt 2, and does not repost the thread", async () => {
  const harness = createHarness("retry");
  const seeded = await harness.seedReview(
    "retry",
    "Reject an empty name first.",
    { kind: "rejected", code: "target_unavailable" },
  );
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const beforeRetryCalls = harness.queueCalls.length;
  try {
    expect(seeded.dispatch.id).toMatch(/^dispatch_/);
    expect(seeded.dispatch.attempts).toEqual([
      expect.objectContaining({ number: 1, state: "rejected" }),
    ]);

    const launched = await harness.launchPage((message) => {
      if (message.includes("Reopen existing review")) return true;
      if (message.includes("Retry this definitively rejected send?")) return true;
      return true;
    });
    browser = launched.browser;

    await harness.waitForShell(launched.page);
    await harness.openSeededReview(launched.page);
    await harness.openReceipts(launched.page);

    expect(
      await launched.page.locator(".cr-receipts [data-action=retry]").count(),
    ).toBe(1);
    expect(await launched.page.locator(".cr-receipts article").first().textContent()).toContain(
      "rejected",
    );

    const originalMessages = harness.store.getThread(harness.who, seeded.threadId)
      .messages
      .map((message) => message.body);
    expect(originalMessages).toEqual([seeded.body]);

    const expectedRowId = 41;
    const retryStartCalls = harness.queueCalls.length;
    const lastAttemptBeforeRetry = harness.store.inspectDispatch(
      harness.who,
      seeded.dispatch.id,
    ).attempts.at(-1);
    expect(lastAttemptBeforeRetry?.state).toBe("rejected");

    harness.pushOutcome({ kind: "accepted", rowId: expectedRowId });
    await launched.page.locator(".cr-receipts [data-action=retry]").click();
    await launched.page.waitForFunction(
      () =>
        document.querySelector(".cr-status")?.textContent?.includes(
          "Retry outcome: accepted",
        ) ?? false,
    );

    expect(harness.queueCalls.length - retryStartCalls).toBe(1);
    expect(harness.queueCalls.length - beforeRetryCalls).toBe(1);
    expect(harness.queueCalls.at(-1)?.content).toContain(
      `dispatch ${seeded.dispatch.id}`,
    );

    const retried = harness.store.inspectDispatch(harness.who, seeded.dispatch.id);
    expect(retried.id).toBe(seeded.dispatch.id);
    expect(retried.attempts.map((attempt) => ({
      number: attempt.number,
      state: attempt.state,
      hostRow: attempt.host_row_id,
    }))).toEqual([
      { number: 1, state: "rejected", hostRow: null },
      { number: 2, state: "accepted", hostRow: expectedRowId },
    ]);
    expect(harness.store.listDispatches(harness.who, seeded.reviewId)).toHaveLength(1);
    expect(harness.store.listThreads(harness.who, seeded.reviewId)).toEqual([
      expect.objectContaining({ id: seeded.threadId }),
    ]);
    expect(
      harness.store.getThread(harness.who, seeded.threadId).messages.map((message) => message.body),
    ).toEqual([seeded.body]);
    expect(
      await launched.page.locator(".cr-receipts [data-action=retry]").count(),
    ).toBe(0);

    await launched.page.reload();
    await harness.waitForShell(launched.page);
    await harness.openSeededReview(launched.page);
    await harness.openReceipts(launched.page);
    expect(await launched.page.locator(".cr-receipts article").first().textContent()).toContain(
      "accepted",
    );
    expect(
      await launched.page.locator(".cr-receipts [data-action=retry]").count(),
    ).toBe(0);
    expect(launched.errors).toEqual([]);
  } finally {
    await browser?.close();
    await harness.cleanup();
  }
}, 45_000);

test("CR-041 browser reconcile marks an unknown attempt with evidence and does not replay queue work", async () => {
  const harness = createHarness("reconcile");
  const seeded = await harness.seedReview(
    "reconcile",
    "Keep the fallback path explicit.",
    { kind: "unknown", message: "acknowledgement lost" },
  );
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    expect(seeded.dispatch.attempts).toEqual([
      expect.objectContaining({ number: 1, state: "unknown" }),
    ]);

    const launched = await harness.launchPage((message) => {
      if (message.includes("Reopen existing review")) return true;
      if (message.includes("accepted or rejected")) return "accepted";
      if (message.includes("Public evidence or receipt reference"))
        return "Matched host receipt row 88";
      return true;
    });
    browser = launched.browser;

    await harness.waitForShell(launched.page);
    await harness.openSeededReview(launched.page);
    await harness.openReceipts(launched.page);

    expect(
      await launched.page.locator(".cr-receipts [data-action=reconcile]").count(),
    ).toBe(1);
    expect(await launched.page.locator(".cr-receipts article").first().textContent()).toContain(
      "unknown",
    );

    const callsBeforeReconcile = harness.queueCalls.length;
    await launched.page.locator(".cr-receipts [data-action=reconcile]").click();
    await launched.page.waitForFunction(
      () =>
        !document.querySelector(".cr-receipts [data-action=reconcile]") &&
        (document.querySelector(".cr-receipts article span")?.textContent?.includes(
          "accepted",
        ) ?? false),
    );
    expect(harness.queueCalls.length).toBe(callsBeforeReconcile);

    const reconciled = harness.store.inspectDispatch(harness.who, seeded.dispatch.id);
    expect(reconciled.id).toBe(seeded.dispatch.id);
    expect(reconciled.attempts.map((attempt) => ({
      number: attempt.number,
      state: attempt.state,
      hostRow: attempt.host_row_id,
      errorCode: attempt.error_code,
    }))).toEqual([
      {
        number: 1,
        state: "accepted",
        hostRow: null,
        errorCode: "enqueue_failed",
      },
    ]);
    expect(
      harness.store
        .events(harness.who, seeded.reviewId)
        .map((event: any) => event.kind),
    ).toEqual([
      "review.created",
      "snapshot.created",
      "thread.created",
      "dispatch.prepared",
      "dispatch.unknown",
      "dispatch.reconciled",
    ]);

    await launched.page.reload();
    await harness.waitForShell(launched.page);
    await harness.openSeededReview(launched.page);
    await harness.openReceipts(launched.page);
    expect(await launched.page.locator(".cr-receipts article").first().textContent()).toContain(
      "accepted",
    );
    expect(
      await launched.page.locator(".cr-receipts [data-action=reconcile]").count(),
    ).toBe(0);
    expect(launched.errors).toEqual([]);
  } finally {
    await browser?.close();
    await harness.cleanup();
  }
}, 45_000);
