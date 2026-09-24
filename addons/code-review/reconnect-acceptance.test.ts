import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type LocalTarget, type ReviewIdentity } from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";
import { SourceReader } from "./source.js";

const ORIGINAL_BODY = "Keep the trim check explicit.";
const DRAFT_BODY = "Private follow-up draft that must survive reconnect.";
const AGENT_REPLY = "Agent confirmed the trim guard is in place.";
const RESOLUTION = "Resolved from durable state after the follow-up landed.";
const UPDATED_SOURCE = [
  "export function validate(name: string) {",
  "  return name.trim().toLowerCase();",
  "}",
  "",
].join("\n");

function createHarness(name: string) {
  const root = mkdtempSync(join(tmpdir(), `review-reconnect-${name}-`));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(
    join(workspace, "sample.ts"),
    [
      "export function validate(name: string) {",
      "  return name.trim();",
      "}",
      "",
    ].join("\n"),
  );

  const workspaceId = `workspace:${name}`;
  const store = new ReviewService(join(root, "review.db"));
  const reader = new SourceReader(workspace, workspaceId);
  const operator: ReviewIdentity = {
    ownerId: `owner:${name}`,
    actorId: `operator:${name}`,
    kind: "operator",
    workspaceId,
  };
  const target: LocalTarget = {
    chatId: `web:worker:${name}`,
    incarnation: `branch:${name}`,
    label: "Implementation",
  };
  const agent: ReviewIdentity = {
    ownerId: operator.ownerId,
    actorId: `agent:${name}`,
    kind: "agent",
    chatId: target.chatId,
    chatIncarnation: target.incarnation,
  };
  const hostTarget = {
    chatJid: target.chatId,
    incarnation: target.incarnation,
    label: target.label,
    agentName: `implementation-${name}`,
    active: true,
  };
  const queueCalls: Array<{
    target: { chatJid: string; incarnation: string };
    content: string;
    mode: "queue";
  }> = [];
  const browserActions: string[] = [];

  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: operator.ownerId,
    actorId: operator.actorId,
    kind: "operator",
    workspaceRoot: workspace,
    workspaceId,
    async listTargets() {
      return [hostTarget];
    },
    async resolveTarget(input) {
      return (
        (input.chatJid === undefined || input.chatJid === hostTarget.chatJid) &&
        (input.agentName === undefined || input.agentName === hostTarget.agentName) &&
        (input.incarnation === undefined ||
          input.incarnation === hostTarget.incarnation)
      )
        ? hostTarget
        : null;
    },
    async enqueue(input) {
      queueCalls.push(input);
      return { status: "accepted" as const, rowId: 100 + queueCalls.length };
    },
  };

  const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:calc(100% - 40px)}</style></head><body><button id="review">Review file</button><main id="pane"></main><script>const handlers=[];let pane;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p},registerWorkspaceAction(a){handlers.push(a)},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};document.getElementById('review').onclick=()=>handlers[0].run({path:'sample.ts',type:'file',name:'sample.ts',chatJid:'${hostTarget.chatJid}'});</script><script type="module" src="/web/index.ts"></script></body></html>`;
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
          browserActions.push(String(body.action || ""));
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

  const waitForShell = async (page: Page, navigate = false) => {
    if (navigate) await page.goto(server.url.href);
    await page.waitForFunction(
      () =>
        !!(window as any).__piclaw_web?.workspaceActionsVersion &&
        document.querySelector("#review") !== null,
    );
  };

  const openReview = async (page: Page) => {
    await page.locator("#review").click();
    await page.waitForSelector(".cr-line");
  };

  const openReceipts = async (page: Page) => {
    await page.locator(".cr-toolbar [data-action=options]").click();
    await page.locator(".cr-menu [data-action=receipts]").click();
    await page.waitForSelector(".cr-receipts");
  };

  const openDrafts = async (page: Page) => {
    await page.locator(".cr-toolbar [data-action=options]").click();
    await page.locator(".cr-menu [data-action=drafts]").click();
    await page.waitForSelector("#cr-body");
  };

  const launchPage = async () => {
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
      const message = dialog.message();
      await dialog.accept(
        message.includes("Draft number")
          ? "1"
          : message.includes("Reopen existing review")
            ? undefined
            : undefined,
      );
    });
    return { browser, page, errors };
  };

  const cleanup = async () => {
    server.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  };

  return {
    workspace,
    store,
    reader,
    ctx,
    operator,
    agent,
    target,
    queueCalls,
    browserActions,
    launchPage,
    waitForShell,
    openReview,
    openReceipts,
    openDrafts,
    cleanup,
  };
}

test("CR-076/165 browser reload reconnects from durable state without polling or replay", async () => {
  const harness = createHarness("cr-076-165");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const created: any = await reviewAction(
      harness.ctx,
      "create",
      {
        path: "sample.ts",
        title: "sample.ts",
        target: {
          chatId: harness.target.chatId,
          incarnation: harness.target.incarnation,
        },
        requestId: "seed-create",
      },
      harness.store,
    );
    const thread: any = await reviewAction(
      harness.ctx,
      "comment",
      {
        reviewId: created.reviewId,
        fileId: created.files[0],
        side: "source",
        range: { startLine: 2, endLine: 2 },
        body: ORIGINAL_BODY,
        requestId: "seed-comment",
      },
      harness.store,
    );
    const draft = harness.store.saveDraft(
      harness.operator,
      created.reviewId,
      {
        threadId: thread.threadId,
        body: DRAFT_BODY,
      },
      { requestId: "seed-draft" },
    );
    const queued: any = await reviewAction(
      harness.ctx,
      "send",
      {
        reviewId: created.reviewId,
        target: {
          chatId: harness.target.chatId,
          incarnation: harness.target.incarnation,
        },
        items: [{ threadId: thread.threadId, version: thread.version }],
        requestId: "seed-send",
      },
      harness.store,
    );
    const seededThread = harness.store.listThreads(
      harness.operator,
      created.reviewId,
    )[0]!;

    expect(harness.queueCalls).toHaveLength(1);
    expect(queued.id).toMatch(/^dispatch_/);
    expect(queued.attempts).toEqual([
      expect.objectContaining({ number: 1, state: "accepted" }),
    ]);

    const launched = await harness.launchPage();
    browser = launched.browser;
    await harness.waitForShell(launched.page, true);
    await harness.openReview(launched.page);
    await launched.page.waitForTimeout(300);

    const idleActionCount = harness.browserActions.length;
    const idleQueueCount = harness.queueCalls.length;

    const agentReply = harness.store.reply(
      harness.agent,
      thread.threadId,
      AGENT_REPLY,
      {
        requestId: "external-reply",
        expectedVersion: thread.version,
      },
      seededThread.assignment_epoch,
    );
    harness.store.updateWork(
      harness.agent,
      queued.id,
      thread.threadId,
      {
        state: "completed",
        itemVersion: 1,
        threadVersion: agentReply.version,
        assignmentEpoch: seededThread.assignment_epoch,
      },
      { requestId: "external-work" },
    );
    harness.store.resolveThread(
      harness.operator,
      thread.threadId,
      {
        explanation: RESOLUTION,
        evidence: ["sample.ts#L2"],
        fileId: created.files[0],
      },
      {
        requestId: "external-resolve",
        expectedVersion: agentReply.version,
      },
    );
    writeFileSync(join(harness.workspace, "sample.ts"), UPDATED_SOURCE);
    const captured = harness.store.capture(
      harness.operator,
      created.reviewId,
      await harness.reader.capture({ path: "sample.ts", mode: "source" }),
      { requestId: "external-capture" },
    );

    await launched.page.waitForTimeout(800);
    expect(harness.browserActions.length).toBe(idleActionCount);
    expect(harness.queueCalls.length).toBe(idleQueueCount);

    await launched.page.reload();
    await harness.waitForShell(launched.page);
    await harness.openReview(launched.page);
    expect(await launched.page.locator("#cr-snapshot").inputValue()).toBe(captured.snapshotId);
    expect(await launched.page.locator(".cr-line").filter({ hasText: "return name.trim().toLowerCase();" }).count()).toBeGreaterThan(0);
    // The new snapshot has a different file ID. The original discussion must
    // remain reachable through the thread drawer and its saved anchor.
    await launched.page.locator(".cr-toolbar [data-action=threads]").click();
    await launched.page.locator(".cr-drawer [data-action=jump]").first().click();
    await launched.page.waitForSelector(".cr-thread");
    expect(await launched.page.locator("#cr-snapshot").inputValue()).toBe(created.snapshotId);

    const threadCard = launched.page.locator(".cr-thread").first();
    expect(await threadCard.textContent()).toContain("resolved");
    await launched.page.waitForFunction((body) => document.querySelector(".cr-thread .cr-message-body")?.textContent?.includes(body) === true, ORIGINAL_BODY);
    expect(await threadCard.textContent()).toContain(ORIGINAL_BODY);
    expect(await threadCard.textContent()).toContain(AGENT_REPLY);
    expect(await threadCard.textContent()).toContain(RESOLUTION);

    await harness.openReceipts(launched.page);
    expect(
      await launched.page.locator(".cr-receipts article").first().textContent(),
    ).toContain("accepted");
    expect(
      await launched.page.locator(".cr-receipts article").first().textContent(),
    ).toContain("1/1 items completed");
    expect(
      await launched.page.locator(".cr-receipts [data-action=retry]").count(),
    ).toBe(0);
    expect(
      await launched.page.locator(".cr-receipts [data-action=reconcile]").count(),
    ).toBe(0);
    await launched.page.locator(".cr-receipts [data-action=close-receipts]").click();

    await harness.openDrafts(launched.page);
    expect(await launched.page.locator("#cr-body").inputValue()).toBe(DRAFT_BODY);

    const finalThread = harness.store.getThread(harness.operator, thread.threadId);
    expect(finalThread.state).toBe("resolved");
    expect(finalThread.messages.map((message) => message.body)).toEqual([
      ORIGINAL_BODY,
      AGENT_REPLY,
      RESOLUTION,
    ]);
    expect(
      finalThread.messages.filter((message) => message.body === AGENT_REPLY),
    ).toHaveLength(1);

    const dispatches = harness.store.listDispatches(
      harness.operator,
      created.reviewId,
    );
    expect(dispatches).toHaveLength(1);
    const inspected = harness.store.inspectDispatch(harness.operator, queued.id);
    expect(inspected.attempts).toEqual([
      expect.objectContaining({ number: 1, state: "accepted" }),
    ]);
    expect(inspected.items).toEqual([
      expect.objectContaining({
        thread_id: thread.threadId,
        work_state: "completed",
        currentThreadState: "resolved",
      }),
    ]);
    expect(
      harness.store.listDrafts(harness.operator, created.reviewId),
    ).toEqual([
      expect.objectContaining({
        id: draft.draftId,
        body: DRAFT_BODY,
        version: draft.version,
      }),
    ]);

    expect(harness.queueCalls).toHaveLength(1);
    expect(harness.browserActions).not.toContain("events");
    expect(harness.browserActions).not.toContain("capture");
    expect(launched.errors).toEqual([]);
  } finally {
    await browser?.close();
    await harness.cleanup();
  }
}, 45_000);
