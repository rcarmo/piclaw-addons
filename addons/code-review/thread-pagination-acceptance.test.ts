import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

test("CR-074 browser pages a long thread without crossing threads or clearing a saved reply draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-history-page-"));
  writeFileSync(join(root, "source.ts"), "export const source = true;\n");
  const store = new ReviewService(join(root, "review.db"));
  const target = { chatJid: "web:worker", incarnation: "branch1", agentName: "worker", label: "Worker", active: false };
  const ctx: LocalContext = {
    version: 1, accessMode: "single-user", ownerId: "owner", actorId: "human", kind: "operator",
    workspaceRoot: root, workspaceId: "workspace",
    async listTargets() { return [target]; },
    async resolveTarget() { return target; },
    async enqueue() { throw Error("No agent work may be queued by reading history."); },
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const review: any = await reviewAction(ctx, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "create" }, store);
    const thread: any = await reviewAction(ctx, "comment", {
      reviewId: review.reviewId, fileId: review.files[0], side: "source", body: "Root guidance", requestId: "root",
    }, store);
    const other: any = await reviewAction(ctx, "comment", {
      reviewId: review.reviewId, fileId: review.files[0], side: "source", body: "Another discussion", requestId: "other",
    }, store);
    for (let n = 1; n <= 104; n++) store.reply(ctx, thread.threadId, `Reply ${n}`, { requestId: `reply-${n}`, expectedVersion: n });
    expect(store.getThread(ctx, thread.threadId, 0, 100).messages).toHaveLength(100);
    expect(store.getThread(ctx, thread.threadId, 100, 100).messages.map((m) => m.ordinal)).toEqual([101, 102, 103, 104, 105]);
    expect(store.getThread(ctx, other.threadId, 100, 100).messages).toEqual([]);
    await expect(reviewAction(ctx, "thread", { threadId: thread.threadId, after: -1 }, store)).rejects.toThrow("cursor");

    const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
    const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:calc(100% - 40px)}</style></head><body><button id="review">Review</button><main id="pane"></main><script>window.__codeReviewReady=false;let pane;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};document.getElementById('review').onclick=()=>window.__piclaw_web.openPane({path:'piclaw://addon/code-review/${review.reviewId}'});</script><script type="module" src="/web/index.ts"></script></body></html>`;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") return new Response(shell, { headers: { "Content-Type": "text/html" } });
      if (["/web/index.ts", "/web/api.ts", "/web/pane.ts", "/web/styles.ts"].includes(path))
        return new Response(transpile.transformSync(await Bun.file(join(import.meta.dir, path.slice(1))).text()), { headers: { "Content-Type": "text/javascript" } });
      if (path === "/agent/addons/api/code-review/action") {
        try { const body = await req.json(); return Response.json({ ok: true, result: await reviewAction(ctx, body.action, body, store) }); }
        catch (error) { return Response.json({ ok: false, error: { message: (error as Error).message } }, { status: 400 }); }
      }
      return new Response("Not found", { status: 404 });
    } });
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME"]) if (process.env[key]) env[key] = process.env[key]!;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PICLAW_REVIEW_TEST_BROWSER || undefined, args: ["--no-sandbox"], env });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.waitForFunction(() => (window as any).__codeReviewReady === true);
    await page.locator("#review").click();
    await page.waitForSelector(`[data-thread="${thread.threadId}"][data-action="expand"]`);
    await page.locator(`[data-thread="${thread.threadId}"][data-action="expand"]`).click();
    await page.waitForFunction((id) => document.querySelector(`#cr-${id} .cr-message-body`)?.textContent === "Root guidance", thread.threadId);
    expect(await page.locator(`#cr-${thread.threadId} .cr-message`).count()).toBe(100);
    expect(await page.locator(`#cr-${thread.threadId} [data-action=more-messages]`).count()).toBe(1);
    await page.locator(`#cr-${thread.threadId} [data-action=reply]`).click();
    await page.locator("#cr-body").fill("Unsent private reply");
    for (let n = 0; n < 30 && !store.listDrafts(ctx, review.reviewId).some((d: any) => d.body === "Unsent private reply"); n++) await Bun.sleep(100);
    expect(store.listDrafts(ctx, review.reviewId).some((d: any) => d.body === "Unsent private reply")).toBe(true);
    await page.locator(`#cr-${thread.threadId} [data-action=more-messages]`).click();
    await page.waitForFunction((id) => document.querySelectorAll(`#cr-${id} .cr-message`).length === 105, thread.threadId);
    const bodies = await page.locator(`#cr-${thread.threadId} .cr-message-body`).allTextContents();
    expect(bodies[0]).toBe("Root guidance");
    expect(bodies[99]).toBe("Reply 99");
    expect(bodies[100]).toBe("Reply 100");
    expect(bodies[104]).toBe("Reply 104");
    expect(await page.locator(`#cr-${thread.threadId} [data-action=more-messages]`).count()).toBe(0);
    expect(await page.locator("#cr-body").inputValue()).toBe("Unsent private reply");
    expect(await page.locator(`#cr-${other.threadId} .cr-message-body`).count()).toBe(0);
    expect(errors).toEqual([]);
    await page.reload();
    await page.waitForFunction(() => (window as any).__codeReviewReady === true);
    await page.locator("#review").click();
    await page.locator(`[data-thread="${thread.threadId}"][data-action="expand"]`).click();
    await page.waitForFunction((id) => document.querySelectorAll(`#cr-${id} .cr-message`).length === 100, thread.threadId);
    expect(store.getThread(ctx, thread.threadId).messages).toHaveLength(100);
    expect(store.getThread(ctx, thread.threadId, 100, 100).messages).toHaveLength(5);
    expect(store.listDrafts(ctx, review.reviewId).some((d: any) => d.body === "Unsent private reply")).toBe(true);
  } finally {
    await browser?.close(); server?.stop(true); store.close(); rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
