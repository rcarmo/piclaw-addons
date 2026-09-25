import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

test("CR-088 Escape and cancelled close preserve unsaved text, focus and committed comments", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-draft-close-"));
  writeFileSync(join(root, "source.ts"), "export const source = true;\n");
  const service = new ReviewService(join(root, "review.db"));
  const target = { chatJid: "web:worker", incarnation: "b1", agentName: "worker", label: "Worker", active: false };
  const ctx: LocalContext = {
    version: 1, accessMode: "single-user", ownerId: "owner", actorId: "human", kind: "operator",
    workspaceRoot: root, workspaceId: "workspace",
    async listTargets() { return [target]; }, async resolveTarget() { return target; },
    async enqueue() { throw Error("Editing a draft cannot enqueue work."); },
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const review: any = await reviewAction(ctx, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "create" }, service);
    const published: any = await reviewAction(ctx, "comment", { reviewId: review.reviewId, fileId: review.files[0], side: "source", body: "Keep published root", requestId: "published" }, service);
    let failDraftSave = true;
    const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
    const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}#pane{height:800px}</style></head><body><main id="pane"></main><script>window.__codeReviewReady=false;let pane;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};</script><script type="module" src="/web/index.ts"></script></body></html>`;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") return new Response(shell, { headers: { "Content-Type": "text/html" } });
      if (["/web/index.ts", "/web/api.ts", "/web/pane.ts", "/web/styles.ts"].includes(path))
        return new Response(transpile.transformSync(await Bun.file(join(import.meta.dir, path.slice(1))).text()), { headers: { "Content-Type": "text/javascript" } });
      if (path === "/agent/addons/api/code-review/action") {
        const body = await req.json();
        if (body.action === "draft" && failDraftSave) return Response.json({ ok: false, error: { message: "Draft save unavailable." } }, { status: 503 });
        try { return Response.json({ ok: true, result: await reviewAction(ctx, body.action, body, service) }); }
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
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.goto(server.url.href);
    await page.waitForFunction(() => (window as any).__codeReviewReady === true);
    await page.evaluate((path: string) => (window as any).__piclaw_web.openPane({ path }), `piclaw://addon/code-review/${review.reviewId}`);
    await page.waitForSelector(".cr-line");
    await page.locator("[data-action=file-comment]").click();
    await page.locator("#cr-body").fill("Unacknowledged text must stay here");
    await page.locator("#cr-body").press("Escape");
    expect(await page.locator("#cr-body").inputValue()).toBe("Unacknowledged text must stay here");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("cr-body");
    await page.waitForFunction(() => document.querySelector(".cr-status")?.textContent?.includes("Draft save unavailable"));
    const close = await page.evaluate(async () => {
      try { await (window as any).instance.beforeDetachFromHost(); return "closed"; }
      catch (error) { return (error as Error).message; }
    });
    expect(close).toContain("Save or explicitly discard");
    expect(await page.locator("#cr-body").inputValue()).toBe("Unacknowledged text must stay here");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("cr-body");
    await page.locator("[data-action=cancel]").click();
    await page.waitForFunction(() => document.querySelector(".cr-status")?.textContent?.includes("Draft acknowledgement is uncertain"));
    expect(await page.locator("#cr-body").inputValue()).toBe("Unacknowledged text must stay here");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("cr-body");
    failDraftSave = false;
    await page.locator("#cr-body").press("ControlOrMeta+s");
    await page.waitForFunction(() => document.querySelector(".cr-composer small")?.textContent === "Draft saved");
    expect(service.listDrafts(ctx, review.reviewId).some((row: any) => row.body === "Unacknowledged text must stay here")).toBe(true);
    await page.locator("[data-action=cancel]").click();
    await page.waitForFunction(() => document.activeElement?.id === "cr-body", null, { timeout: 1500 });
    expect(dialogs).toContain("Discard this unposted text?");
    expect(await page.locator("#cr-body").inputValue()).toBe("Unacknowledged text must stay here");
    expect(service.getThread(ctx, published.threadId).messages[0].body).toBe("Keep published root");
    expect(errors).toEqual([]);
  } finally { await browser?.close(); server?.stop(true); service.close(); rmSync(root, { recursive: true, force: true }); }
}, 45_000);
