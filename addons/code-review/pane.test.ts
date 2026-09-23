import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";
test("CR-001/012/033/111 browser drives real review persistence and one explicit queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-ui-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "other.ts"), "const another = true;\n");
  writeFileSync(
    join(workspace, "sample.ts"),
    "export function validate(name: string) {\n  return name.trim();\n}\n",
  );
  const store = new ReviewService(join(root, "review.db"));
  let browser, server;
  let calls = 0;
  const target = {
    chatJid: "web:worker",
    incarnation: "b1",
    label: "Implementation",
    agentName: "implementation",
    active: true,
  };
  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: "operator1",
    actorId: "human1",
    kind: "operator",
    workspaceRoot: workspace,
    workspaceId: "workspace1",
    async listTargets() {
      return [target];
    },
    async resolveTarget(input) {
      return input.chatJid === target.chatJid &&
        (!input.incarnation || input.incarnation === target.incarnation)
        ? target
        : null;
    },
    async enqueue() {
      calls++;
      return { status: "accepted", rowId: calls };
    },
  };
  try {
    const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
    const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:calc(100% - 40px)}</style></head><body><button id="review">Review file</button><main id="pane"></main><script>const handlers=[];let pane;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p},registerWorkspaceAction(a){handlers.push(a)},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};document.getElementById('review').onclick=()=>handlers[0].run({path:'sample.ts',type:'file',name:'sample.ts',chatJid:'web:worker'});</script><script type="module" src="/web/index.ts"></script></body></html>`;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/")
          return new Response(shell, {
            headers: { "Content-Type": "text/html" },
          });
        if (
          [
            "/web/index.ts",
            "/web/api.ts",
            "/web/pane.ts",
            "/web/styles.ts",
          ].includes(path)
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
          } catch (err) {
            return Response.json({
              ok: false,
              error: { message: (err as Error).message },
            });
          }
        }
        return new Response("Not found", { status: 404 });
      },
    });
    const env: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME"])
      if (process.env[k]) env[k] = process.env[k]!;
    browser = await chromium.launch({
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
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) =>
      d.accept(
        d.message().includes("workspace-relative")
          ? "other.ts"
          : d.message().includes("Draft number")
            ? "1"
            : "Confirmed",
      ),
    );
    await page.goto(server.url.href);
    await page.click("#review");
    await page.waitForSelector(".cr-line");
    expect(await page.locator(".cr-line").count()).toBe(3);
    expect(await page.locator(".tok-keyword").count()).toBeGreaterThan(0);
    expect(await page.locator("#viewed").count()).toBe(0);
    await page.locator('[data-action=line-comment][data-line="2"]').click();
    await page.locator("#cr-body").fill("Reject an empty name first.");
    await page.waitForTimeout(650);
    await page.locator("[data-action=post]").click();
    await page.waitForSelector(".cr-thread", { timeout: 5000 });
    expect(calls).toBe(0);
    expect(store.listReviews(ctx)).toHaveLength(1);
    const review = store.listReviews(ctx)[0]!;
    expect(store.listThreads(ctx, review.id)).toHaveLength(1);
    await page.locator(".cr-thread [data-pick]").check();
    await page.locator("[data-action=send]").click();
    await page.waitForSelector(".cr-drawer");
    await page.locator("[data-action=confirm-send]").click();
    await page.waitForFunction(() =>
      document.querySelector(".cr-status")?.textContent?.includes("accepted"),
    );
    expect(calls).toBe(1);
    const thread = store.listThreads(ctx, review.id)[0]!;
    expect(store.getThread(ctx, thread.id).messages[0]?.body).toBe(
      "Reject an empty name first.",
    );
    expect(thread.state).toBe("open");
    expect(store.listDrafts(ctx, review.id)).toHaveLength(0);
    expect(
      await page
        .locator(".cr-line")
        .first()
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(18);
    await page.reload();
    await page.click("#review");
    await page.waitForSelector(".cr-line");
    await page.waitForSelector(".cr-thread");
    expect(store.listReviews(ctx)).toHaveLength(1);
    // Acknowledged drafts survive closing the composer view and changing files.
    await page.locator("[data-action=options]").click();
    await page.locator("[data-action=add-file]").click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".cr-files [data-action=file]").length === 2,
    );
    const sample = page
        .locator(".cr-files [data-action=file]")
        .filter({ hasText: "sample.ts" }),
      other = page
        .locator(".cr-files [data-action=file]")
        .filter({ hasText: "other.ts" });
    await sample.click();
    await page.locator("[data-action=file-comment]").click();
    await page
      .locator("#cr-body")
      .fill("Preserve this draft across file navigation.");
    await page.waitForTimeout(700);
    await other.click();
    await page.waitForFunction(
      () =>
        document.querySelector(".cr-file-header strong")?.textContent ===
        "other.ts",
    );
    expect(await page.locator("#cr-body").count()).toBe(0);
    await sample.click();
    await page.waitForFunction(
      () =>
        document.querySelector(".cr-file-header strong")?.textContent ===
        "sample.ts",
    );
    expect(await page.locator("#cr-body").inputValue()).toBe(
      "Preserve this draft across file navigation.",
    );
    await page.reload();
    await page.click("#review");
    await page.waitForSelector(".cr-line");
    await page
      .locator(".cr-files [data-action=file]")
      .filter({ hasText: "sample.ts" })
      .click();
    await page.locator("[data-action=options]").click();
    await page.locator("[data-action=drafts]").click();
    expect(await page.locator("#cr-body").inputValue()).toBe(
      "Preserve this draft across file navigation.",
    );
    // Typing into a new composer cannot strand an in-flight acknowledged draft.
    await page.locator("#cr-body").fill("Updated before next composer.");
    await page.locator('[data-action=line-comment][data-line="1"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector(".cr-composer>strong")?.textContent ===
        "Range comment",
    );
    expect(
      store
        .listDrafts(ctx, review.id)
        .some((d: any) => d.body === "Updated before next composer."),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    server?.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
