import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

const ORIGINAL = "export function value() {\n  return 'before';\n}\n";
const CHANGED = "export function value() {\n  return 'after';\n}\n";
test("CR-063 source refresh and a new agent reply preserve an acknowledged reply draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-refresh-draft-"));
  const source = join(root, "source.ts"); writeFileSync(source, ORIGINAL);
  const store = new ReviewService(join(root, "review.db"));
  const target = { chatJid: "web:worker", incarnation: "b1", agentName: "worker", label: "Worker", active: false };
  let queued = 0;
  const ctx: LocalContext = { version: 1, accessMode: "single-user", ownerId: "owner", actorId: "human", kind: "operator", workspaceRoot: root, workspaceId: "workspace",
    async listTargets() { return [target]; }, async resolveTarget() { return target; }, async enqueue() { queued++; return { status: "accepted", rowId: queued }; } };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const review: any = await reviewAction(ctx, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "create" }, store);
    const thread: any = await reviewAction(ctx, "comment", { reviewId: review.reviewId, fileId: review.files[0], side: "source", range: { startLine: 2, endLine: 2 }, body: "Preserve the concern", requestId: "thread" }, store);
    const trusted = { ownerId: ctx.ownerId, actorId: ctx.actorId, kind: "operator" as const, workspaceId: ctx.workspaceId };
    const submitted = store.submit(trusted, review.reviewId, { target: { chatId: target.chatJid, incarnation: target.incarnation, label: target.label }, items: [{ threadId: thread.threadId, version: thread.version }] }, { requestId: "seed-send" });
    await store.deliver(trusted, submitted.dispatchId, { async enqueue() { return { status: "accepted" as const, rowId: 1 }; } });
    const agentCtx: LocalContext = { ...ctx, kind: "agent", actorId: "b1", chatJid: target.chatJid, chatIncarnation: target.incarnation, reference: { addonId: "code-review", intentId: submitted.dispatchId } };
    const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
    const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}#pane{height:800px}</style></head><body><main id="pane"></main><script>window.__codeReviewReady=false;let pane;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};</script><script type="module" src="/web/index.ts"></script></body></html>`;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") return new Response(shell, { headers: { "Content-Type": "text/html" } });
      if (["/web/index.ts", "/web/api.ts", "/web/pane.ts", "/web/styles.ts"].includes(path)) return new Response(transpile.transformSync(await Bun.file(join(import.meta.dir, path.slice(1))).text()), { headers: { "Content-Type": "text/javascript" } });
      if (path === "/agent/addons/api/code-review/action") { try { const body = await req.json(); return Response.json({ ok: true, result: await reviewAction(ctx, body.action, body, store) }); } catch (error) { return Response.json({ ok: false, error: { message: (error as Error).message } }, { status: 400 }); } }
      return new Response("Not found", { status: 404 });
    } });
    const env: Record<string, string> = {}; for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME"]) if (process.env[key]) env[key] = process.env[key]!;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PICLAW_REVIEW_TEST_BROWSER || undefined, args: ["--no-sandbox"], env });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href); await page.waitForFunction(() => (window as any).__codeReviewReady === true);
    await page.evaluate((path: string) => (window as any).__piclaw_web.openPane({ path }), `piclaw://addon/code-review/${review.reviewId}`);
    await page.waitForSelector(`#cr-${thread.threadId}`);
    if (await page.locator(`#cr-${thread.threadId} [data-action=expand]`).getAttribute("aria-expanded") !== "true") await page.locator(`#cr-${thread.threadId} [data-action=expand]`).click();
    await page.locator(`#cr-${thread.threadId} [data-action=reply]`).click();
    await page.locator("#cr-body").fill("Unsent answer stays targeted to this thread");
    for (let n = 0; n < 30 && !store.listDrafts(ctx, review.reviewId).some((d: any) => d.body === "Unsent answer stays targeted to this thread" && d.thread_id === thread.threadId); n++) await Bun.sleep(100);
    expect(store.listDrafts(ctx, review.reviewId).some((d: any) => d.body === "Unsent answer stays targeted to this thread" && d.thread_id === thread.threadId)).toBe(true);
    writeFileSync(source, CHANGED);
    await reviewAction(agentCtx, "reply", { threadId: thread.threadId, body: "Agent replied while draft was open", expectedVersion: 1, assignmentEpoch: 1, requestId: "agent-reply" }, store);
    await page.locator("[data-action=options]").click();
    await page.locator("[data-action=refresh]").click();
    await page.waitForFunction(() => document.querySelector(".cr-source")?.textContent?.includes("after") === true);
    expect(await page.locator("#cr-body").inputValue()).toBe("Unsent answer stays targeted to this thread");
    expect(await page.evaluate((id: string) => (window as any).instance?.detail?.get(id)?.messages?.length, thread.threadId)).toBe(2);
    expect(store.listDrafts(ctx, review.reviewId).some((d: any) => d.body === "Unsent answer stays targeted to this thread" && d.thread_id === thread.threadId)).toBe(true);
    await page.locator("[data-action=threads]").click();
    await page.locator(".cr-drawer [data-action=jump]").click();
    await page.waitForFunction((id) => document.querySelector(`#cr-${id}`) !== null, thread.threadId);
    await page.waitForFunction((id) => [...document.querySelectorAll(`#cr-${id} .cr-message-body`)].some((node) => node.textContent?.includes("Agent replied while draft was open")), thread.threadId);
    expect(await page.locator("#cr-body").inputValue()).toBe("Unsent answer stays targeted to this thread");
    expect(store.getThread(ctx, thread.threadId).messages.map((m) => m.body)).toEqual(["Preserve the concern", "Agent replied while draft was open"]);
    expect(store.getThread(ctx, thread.threadId).anchor.snapshotFileId).toBe(review.files[0]);
    expect(queued).toBe(0); expect(errors).toEqual([]);
  } finally { await browser?.close(); server?.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); }
}, 45_000);
