import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

test("CR-085/137 keyboard range and drawer actions remain reachable in a 390px pane", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-keyboard-narrow-"));
  writeFileSync(join(root, "source.ts"), "const first = 1;\nconst second = 2;\nconst third = 3;\n");
  const service = new ReviewService(join(root, "review.db"));
  const target = { chatJid: "web:worker", incarnation: "b1", agentName: "worker", label: "Worker", active: false };
  let queueCalls = 0;
  const ctx: LocalContext = { version: 1, accessMode: "single-user", ownerId: "owner", actorId: "human", kind: "operator", workspaceRoot: root, workspaceId: "workspace",
    async listTargets() { return [target]; }, async resolveTarget() { return target; }, async enqueue() { queueCalls++; return { status: "accepted", rowId: queueCalls }; } };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const review: any = await reviewAction(ctx, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "create" }, service);
    const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
    const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:100%;width:100%}</style></head><body><main id="pane"></main><script>window.__codeReviewReady=false;let pane;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};</script><script type="module" src="/web/index.ts"></script></body></html>`;
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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.waitForFunction(() => (window as any).__codeReviewReady === true);
    await page.evaluate((path: string) => (window as any).__piclaw_web.openPane({ path }), `piclaw://addon/code-review/${review.reviewId}`);
    await page.waitForSelector(".cr-line[data-line='3']");
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".cr-pane")?.dataset.narrow === "true");
    expect(await page.locator(".cr-pane").getAttribute("data-narrow")).toBe("true");
    const source = page.locator(".cr-source");
    expect(await source.getAttribute("tabindex")).toBe("0");
    await page.locator('.cr-line [data-action=select-line][data-line="1"]').focus();
    await page.keyboard.press("Enter");
    await page.locator('.cr-line [data-action=select-line][data-line="3"]').focus();
    await page.keyboard.press("Enter");
    expect(await page.locator(".cr-selection").innerText()).toContain("source lines 1–3");
    await page.locator("[data-action=range-comment]").focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("cr-body");
    await page.locator("#cr-body").fill("Keep the three-line range");
    await page.locator("[data-action=post]").focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".cr-thread");
    const thread = service.listThreads(ctx, review.reviewId)[0]!;
    expect(thread.anchor).toMatchObject({ scope: "range", startLine: 1, endLine: 3 });
    expect(queueCalls).toBe(0);
    await page.locator("[data-action=threads]").focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".cr-drawer");
    expect(await page.locator(".cr-drawer").getAttribute("role")).toBe("dialog");
    const drawerBounds = await page.locator(".cr-drawer").boundingBox();
    const paneBounds = await page.locator(".cr-pane").boundingBox();
    expect(drawerBounds).not.toBeNull(); expect(paneBounds).not.toBeNull();
    expect(drawerBounds!.width).toBeLessThanOrEqual(paneBounds!.width + 1);
    expect(drawerBounds!.x).toBeGreaterThanOrEqual(paneBounds!.x - 1);
    await page.keyboard.press("Escape");
    expect(await page.locator(".cr-drawer").count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-action"))).toBe("threads");
    expect(queueCalls).toBe(0);
    expect(errors).toEqual([]);
  } finally { await browser?.close(); server?.stop(true); service.close(); rmSync(root, { recursive: true, force: true }); }
}, 45_000);
