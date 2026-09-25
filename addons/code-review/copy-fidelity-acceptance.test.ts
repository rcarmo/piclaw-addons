import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

const SOURCE = "\tconst before = '<img src=x onerror=alert(1)>';\n\n  const after = true;\n";
test("CR-149 source copy preserves tabs, blank lines and HTML-like text without gutters", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-copy-fidelity-"));
  const filePath = join(root, "source.ts");
  writeFileSync(filePath, SOURCE);
  const before = readFileSync(filePath);
  const service = new ReviewService(join(root, "review.db"));
  const target = { chatJid: "web:worker", incarnation: "b1", agentName: "worker", label: "Worker", active: false };
  const ctx: LocalContext = { version: 1, accessMode: "single-user", ownerId: "owner", actorId: "human", kind: "operator", workspaceRoot: root, workspaceId: "workspace",
    async listTargets() { return [target]; }, async resolveTarget() { return target; }, async enqueue() { throw Error("Copy cannot queue work."); } };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const review: any = await reviewAction(ctx, "create", { path: "source.ts", target: { agentName: "worker" }, requestId: "create" }, service);
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.waitForFunction(() => (window as any).__codeReviewReady === true);
    await page.evaluate((path: string) => (window as any).__piclaw_web.openPane({ path }), `piclaw://addon/code-review/${review.reviewId}`);
    await page.waitForSelector(".cr-line[data-line='3']");
    expect(await page.locator(".cr-line").count()).toBe(3);
    expect(await page.locator(".cr-line[data-line='2'] code").textContent()).toBe("");
    expect(await page.locator(".cr-line[data-line='1'] code").textContent()).toBe(SOURCE.split("\n")[0]);
    expect(await page.locator(".cr-line[data-line='1'] code").innerHTML()).toContain("&lt;img");
    expect(await page.locator(".cr-line[data-line='1'] img").count()).toBe(0);
    const selected = await page.evaluate(() => {
      const first = document.querySelector(".cr-line[data-line='1'] code")!;
      const last = document.querySelector(".cr-line[data-line='3'] code")!;
      const range = document.createRange();
      range.selectNodeContents(first);
      range.setEnd(last, last.childNodes.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    });
    expect(selected).toContain(SOURCE.split("\n")[0]);
    expect(selected).toContain("+\n2"); // Native DOM selection includes gutters; copy handler must not.
    await page.keyboard.press("ControlOrMeta+c");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(SOURCE.trimEnd());
    expect(clipboard).not.toContain("1\t");
    const partial = await page.evaluate(() => {
      const code = document.querySelector(".cr-line[data-line='1'] code")!;
      const text = code.textContent!;
      const start = text.indexOf("<img");
      const length = "<img src=x onerror=alert(1)>".length;
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      let node: Node | null, cursor = 0, startNode: Node | null = null, endNode: Node | null = null;
      let startOffset = 0, endOffset = 0;
      while ((node = walker.nextNode())) {
        const span = node.textContent!.length;
        if (!startNode && start >= cursor && start < cursor + span) { startNode = node; startOffset = start - cursor; }
        if (!endNode && start + length > cursor && start + length <= cursor + span) { endNode = node; endOffset = start + length - cursor; }
        cursor += span;
      }
      const range = document.createRange();
      range.setStart(startNode!, startOffset); range.setEnd(endNode!, endOffset);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    });
    expect(partial).toBe("<img src=x onerror=alert(1)>");
    await page.keyboard.press("ControlOrMeta+c");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(partial);
    expect(readFileSync(filePath).equals(before)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser?.close(); server?.stop(true); service.close(); rmSync(root, { recursive: true, force: true }); }
}, 45_000);
