import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

test("CR-011 missing and unreadable current files retain saved discussion and never reattach its anchor", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-missing-pane-"));
  const source = join(root, "source.ts");
  const saved = "export const original = 1;\n";
  writeFileSync(source, saved);
  const service = new ReviewService(join(root, "review.db"));
  const target = { chatJid: "web:worker", incarnation: "b1", agentName: "worker", label: "Worker", active: false };
  const ctx: LocalContext = {
    version: 1, accessMode: "single-user", ownerId: "owner", actorId: "human", kind: "operator",
    workspaceRoot: root, workspaceId: "workspace",
    async listTargets() { return [target]; }, async resolveTarget() { return target; },
    async enqueue() { throw Error("Reading a missing file must never queue work."); },
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const review: any = await reviewAction(ctx, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "create" }, service);
    const thread: any = await reviewAction(ctx, "comment", {
      reviewId: review.reviewId, fileId: review.files[0], side: "source",
      range: { startLine: 1, endLine: 1 }, body: "Keep original review guidance", requestId: "thread",
    }, service);
    unlinkSync(source);
    writeFileSync(source, "replacement with different inode\n");
    const replaced: any = await reviewAction(ctx, "file", { reviewId: review.reviewId, fileId: review.files[0] }, service);
    expect(replaced.currentSource.status).toBe("replaced");
    expect(replaced.new.lines[0].text).toBe(saved.trim());
    unlinkSync(source);
    const missing: any = await reviewAction(ctx, "file", { reviewId: review.reviewId, fileId: review.files[0] }, service);
    expect(missing.currentSource.status).toBe("missing");
    expect(missing.new.lines[0].text).toBe(saved.trim());
    const original = service.getThread(ctx, thread.threadId).anchor;
    const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
    const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}#pane{height:800px}</style></head><body><main id="pane"></main><script>window.__codeReviewReady=false;let pane;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};</script><script type="module" src="/web/index.ts"></script></body></html>`;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") return new Response(shell, { headers: { "Content-Type": "text/html" } });
      if (["/web/index.ts", "/web/api.ts", "/web/pane.ts", "/web/styles.ts"].includes(path))
        return new Response(transpile.transformSync(await Bun.file(join(import.meta.dir, path.slice(1))).text()), { headers: { "Content-Type": "text/javascript" } });
      if (path === "/agent/addons/api/code-review/action") {
        try { const body = await req.json(); return Response.json({ ok: true, result: await reviewAction(ctx, body.action, body, service) }); }
        catch (error) { return Response.json({ ok: false, error: { message: (error as Error).message } }, { status: 400 }); }
      }
      return new Response("Not found", { status: 404 });
    } });
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME"]) if (process.env[key]) env[key] = process.env[key]!;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PICLAW_REVIEW_TEST_BROWSER || undefined, args: ["--no-sandbox"], env });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.waitForFunction(() => (window as any).__codeReviewReady === true);
    await page.evaluate((path: string) => (window as any).__piclaw_web.openPane({ path }), `piclaw://addon/code-review/${review.reviewId}`);
    await page.waitForSelector(".cr-current-source");
    expect(await page.locator(".cr-current-source").innerText()).toBe("Current saved file: missing");
    expect(await page.locator(".cr-line code").first().textContent()).toBe(saved.trim());
    if (await page.locator(`#cr-${thread.threadId} [data-action=expand]`).getAttribute("aria-expanded") !== "true") await page.locator(`#cr-${thread.threadId} [data-action=expand]`).click();
    expect(await page.locator(`#cr-${thread.threadId} .cr-message-body`).innerText()).toContain("Keep original review guidance");
    expect(service.getThread(ctx, thread.threadId).anchor).toEqual(original);
    mkdirSync(source);
    await page.reload();
    await page.waitForFunction(() => (window as any).__codeReviewReady === true);
    await page.evaluate((path: string) => (window as any).__piclaw_web.openPane({ path }), `piclaw://addon/code-review/${review.reviewId}`);
    await page.waitForSelector(".cr-current-source");
    expect(await page.locator(".cr-current-source").innerText()).toBe("Current saved file: unavailable");
    expect(await page.locator(".cr-line code").first().textContent()).toBe(saved.trim());
    expect(service.getThread(ctx, thread.threadId).anchor).toEqual(original);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close(); server?.stop(true); service.close(); rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
