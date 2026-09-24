import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

const S1 = "before\nstart\nconcern\nend\nafter\n";
const S2 = "before\nstart\nreplacement\nend\nafter\n";
const S3 = S1 + "gap\n" + S1;
test("CR-056/057 missing and ambiguous projections stay off source rows while original discussion remains reachable", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-anchor-pane-"));
  const source = join(root, "source.ts"); writeFileSync(source, S1);
  const store = new ReviewService(join(root, "review.db"));
  const target = { chatJid: "web:worker", incarnation: "b1", agentName: "worker", label: "Worker", active: false };
  let queueCalls = 0;
  const ctx: LocalContext = { version: 1, accessMode: "single-user", ownerId: "owner", actorId: "human", kind: "operator", workspaceRoot: root, workspaceId: "workspace",
    async listTargets() { return [target]; }, async resolveTarget() { return target; }, async enqueue() { queueCalls++; return { status: "accepted", rowId: queueCalls }; } };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const created: any = await reviewAction(ctx, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "create" }, store);
    const thread: any = await reviewAction(ctx, "comment", { reviewId: created.reviewId, fileId: created.files[0], side: "source", range: { startLine: 3, endLine: 3 }, body: "Handle the original concern", requestId: "thread" }, store);
    const anchor = store.getThread(ctx, thread.threadId).anchor;
    const snapshots = [created.snapshotId];
    for (const [id, text] of [["missing", S2], ["ambiguous", S3]] as const) {
      writeFileSync(source, text);
      const captured: any = await reviewAction(ctx, "capture", { reviewId: created.reviewId, source: { path: "source.ts", mode: "source" }, requestId: id }, store);
      snapshots.push(captured.snapshotId);
      const projection: any = await reviewAction(ctx, "projection", { threadId: thread.threadId, fileId: captured.files[0] }, store);
      expect(projection).toMatchObject({ status: id, startLine: null, endLine: null });
    }
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
    await page.evaluate((path: string) => (window as any).__piclaw_web.openPane({ path }), `piclaw://addon/code-review/${created.reviewId}`);
    await page.waitForSelector(".cr-line");
    for (const [id, snapshotId] of [["ambiguous", snapshots[2]], ["missing", snapshots[1]]] as const) {
      await page.locator("#cr-snapshot").selectOption(snapshotId);
      await page.waitForFunction((selected) => (document.querySelector("#cr-snapshot") as HTMLSelectElement | null)?.value === selected, snapshotId);
      const selectedFile = store.snapshotFiles(ctx, created.reviewId, snapshotId)[0]!;
      await page.waitForFunction((hash) => document.querySelector(".cr-file-header .cr-muted")?.textContent?.includes(hash) === true, selectedFile.new_hash!.slice(0, 10));
      expect(await page.locator(`#cr-${thread.threadId}`).count()).toBe(0);
      await page.locator(".cr-toolbar [data-action=threads]").click();
      await page.waitForSelector(`.cr-drawer [data-thread="${thread.threadId}"]`);
      expect(await page.locator(`.cr-drawer [data-thread="${thread.threadId}"]`).getAttribute("title")).toContain("original source");
      expect(await page.locator(`.cr-drawer [data-thread="${thread.threadId}"]`).locator("xpath=preceding-sibling::small[1]").innerText()).toContain(id === "missing" ? "outdated (not mapped)" : "ambiguous (not mapped)");
      await page.locator(`.cr-drawer [data-thread="${thread.threadId}"]`).click();
      await page.waitForFunction((selected) => (document.querySelector("#cr-snapshot") as HTMLSelectElement | null)?.value === selected, created.snapshotId);
      await page.waitForFunction((id) => document.querySelector(`#cr-${id} .cr-message-body`)?.textContent?.includes("Handle the original concern") === true, thread.threadId);
      expect(await page.locator(`#cr-${thread.threadId} .cr-message-body`).innerText()).toContain("Handle the original concern");
      expect(store.getThread(ctx, thread.threadId).anchor).toEqual(anchor);
    }
    expect(queueCalls).toBe(0); expect(errors).toEqual([]);
  } finally { await browser?.close(); server?.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); }
}, 45_000);
