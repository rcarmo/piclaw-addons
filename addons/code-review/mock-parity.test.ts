import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ReviewService } from "./dispatch.js";
import { reviewAction } from "./runtime.js";
import type { LocalContext } from "./host.js";

test("RC-1/2/3 render the approved mock source, diff and send states with real stored summaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-mock-parity-"));
  const mock = readFileSync(resolve(import.meta.dir, "../../specs/code-review/review-pane-mock.html"), "utf8");
  const syntax = JSON.parse(mock.match(/id="mock-syntax-fixtures">([\s\S]*?)<\/script>/)![1]!);
  const source = syntax.validation.source.text.join("\n") + "\n";
  const old = syntax.validation.old.text.join("\n") + "\n";
  const body = "Please keep validation before the network request. Include the whitespace-only case.";
  mkdirSync(join(root, "src"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: {
    PATH: process.env.PATH!, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  }, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(root, "src/validation.ts"), old);
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "baseline");
  writeFileSync(join(root, "src/validation.ts"), source);
  const store = new ReviewService(join(root, "review.db"));
  const target = { chatJid: "web:implementation", incarnation: "fixture-1", agentName: "implementation", label: "@implementation", active: false };
  let queued = 0;
  const actions: string[] = [];
  const ctx: LocalContext = { version: 1, accessMode: "single-user", ownerId: "owner", actorId: "human", kind: "operator", workspaceRoot: root, workspaceId: "fixture",
    async listTargets() { return [target]; }, async resolveTarget() { return target; },
    async enqueue() { return { status: "accepted", rowId: ++queued }; } };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const review: any = await reviewAction(ctx, "create", { path: "src/validation.ts", target: { agentName: "implementation" }, requestId: "create" }, store);
    const thread: any = await reviewAction(ctx, "comment", { reviewId: review.reviewId, fileId: review.files[0], side: "source", range: { startLine: 4, endLine: 7 }, body, requestId: "comment" }, store);
    const palette = ":root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-tertiary:#eee;--bg-hover:#eee;--bg-code:#fff;--text-code:#222;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--accent-soft:#edf6f8;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace;--font-size-md:15px}";
    const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/static/classic/fixture.css") return new Response(palette, { headers: { "Content-Type": "text/css" } });
      if (path === "/mock") return new Response(mock, { headers: { "Content-Type": "text/html" } });
      if (path === "/") return new Response(`<!doctype html><link rel="stylesheet" href="/static/classic/fixture.css"><style>html,body{margin:0;height:100%}#pane{height:100%}</style><main id="pane"></main><script>let pane;window.__ready=false;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;window.__ready=true},registerWorkspaceAction(){},openPane(){return true}};window.openReview=()=>pane.mount(document.querySelector('#pane'),{path:${JSON.stringify("piclaw://addon/code-review/" + review.reviewId)}});</script><script type="module" src="/web/index.ts"></script>`, { headers: { "Content-Type": "text/html" } });
      if (["/web/index.ts", "/web/pane.ts", "/web/api.ts", "/web/styles.ts"].includes(path))
        return new Response(transpile.transformSync(readFileSync(join(import.meta.dir, path.slice(1)), "utf8")), { headers: { "Content-Type": "text/javascript" } });
      if (path === "/agent/addons/api/code-review/action") {
        try { const body = await req.json(); actions.push(body.action); return Response.json({ ok: true, result: await reviewAction(ctx, body.action, body, store) }); }
        catch (error) { return Response.json({ ok: false, error: { message: (error as Error).message } }); }
      }
      return new Response("Not found", { status: 404 });
    } });
    browser = await chromium.launch({ headless: true, executablePath: process.env.PICLAW_REVIEW_TEST_BROWSER, args: ["--no-sandbox"], env: { PATH: process.env.PATH!, HOME: root } });
    const real = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const reference = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    for (const page of [real, reference]) page.on("pageerror", (error) => errors.push(error.message));
    await real.goto(server.url.href);
    await real.waitForFunction(() => (window as any).__ready);
    await real.evaluate(() => (window as any).openReview());
    await real.waitForSelector(".cr-thread");
    await reference.goto(server.url.href + "mock");
    await reference.evaluate(() => { document.documentElement.dataset.hostSkin = "classic"; });
    // Use the same palette and crop out the mock's synthetic app chrome only.
    await reference.addStyleTag({ content: palette + ".design-bar,.explorer,.tabs,.design-notes,.footer-note{display:none!important}.frame{display:block!important}.workspace{width:100%}" });
    const output = process.env.PICLAW_REVIEW_PARITY_OUTPUT;
    if (output) mkdirSync(output, { recursive: true });
    const shot = async (state: string, width: number) => {
      if (!output) return;
      await real.screenshot({ path: join(output, `implementation-${state}-${width}.png`) });
      await reference.screenshot({ path: join(output, `mock-${state}-${width}.png`) });
    };
    const dimensions: any[] = [];
    for (const width of [1280, 520]) {
      await real.setViewportSize({ width, height: 900 });
      await reference.setViewportSize({ width, height: 900 });
      await real.waitForFunction((narrow) => document.querySelector<HTMLElement>(".cr-pane")?.dataset.narrow === narrow, String(width < 720));
      const metrics = async (page: typeof real, row: string, toolbar: string) => page.evaluate(({ row, toolbar }) => {
        const code = getComputedStyle(document.querySelector(row)!);
        return { font: code.fontSize, line: code.lineHeight, padding: code.paddingTop, toolbar: document.querySelector(toolbar)!.getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth };
      }, { row, toolbar });
      const actual = await metrics(real, ".cr-line", ".cr-toolbar"), expected = await metrics(reference, ".code-row", ".toolbar");
      expect(actual.font).toBe(expected.font); expect(actual.line).toBe(expected.line); expect(actual.padding).toBe(expected.padding);
      if (width === 1280) { expect(actual.toolbar).toBeLessThanOrEqual(46); expect(expected.toolbar).toBeLessThanOrEqual(46); }
      expect(actual.overflow).toBe(false);
      dimensions.push({ width, actual, mock: expected });
      expect(await real.locator("#cr-snapshot").isVisible()).toBe(false);
      expect(await real.locator(".cr-message").first().innerText()).toContain(body);
      expect(await real.locator(".cr-delivery").first().innerText()).toBe("Not sent");
      await shot("source", width);
      expect(await real.locator(".cr-thread [data-action=expand]").getAttribute("aria-expanded")).toBe("true");
      await real.locator(".cr-message-body").waitFor();
      expect(await real.locator(".cr-message-body").innerText()).toBe(body);
      await shot("discussion", width);
      await real.locator(`.cr-thread [data-pick="${thread.threadId}"]`).check();
      await reference.locator('#t1 [data-pick="t1"]').check();
      await real.locator("[data-action=send]").click();
      await real.locator(".cr-drawer").waitFor();
      await reference.locator("#send-review").click();
      expect(await real.locator(".cr-thread-path").innerText()).toBe("src/validation.ts");
      expect(await real.locator(".cr-thread-summary").innerText()).toBe(body);
      await shot("send", width);
      await real.locator("button[data-action=close-drawer]").click();
      await reference.locator("#close-drawer").click();
    }
    await real.locator("#cr-source-mode").selectOption("unstaged");
    await real.waitForFunction(() => document.querySelector("#cr-snapshot option:checked")?.textContent?.includes("unstaged"));
    await reference.locator("#source-mode").selectOption("diff");
    expect(await real.locator(".cr-diff-line .cr-old-line").count()).toBeGreaterThan(0);
    await real.locator(".cr-toolbar [data-action=files]").click();
    expect(await real.locator(".cr-file-stats").innerText()).toContain("1 open");
    expect(await real.locator(".cr-file-add").innerText()).not.toBe("+0");
    await real.locator(".cr-toolbar [data-action=files]").click();
    await shot("diff", 520);
    expect(queued).toBe(0);
    store.resolveThread(ctx, thread.threadId, { explanation: "Checked the original range", fileId: review.files[0], evidence: ["src/validation.ts#L4", "https://example.invalid/checks"] }, { requestId: "resolve", expectedVersion: 1 });
    await real.reload();
    await real.waitForFunction(() => (window as any).__ready);
    await real.evaluate(() => (window as any).openReview());
    await real.waitForSelector(".cr-thread");
    await real.locator(".cr-thread [data-action=expand]").click();
    await real.locator(".cr-evidence").waitFor();
    expect(await real.locator(".cr-evidence").innerText()).toContain("Addressed guidance v1");
    expect(await real.locator(".cr-evidence code").innerText()).toBe("src/validation.ts#L4");
    expect(await real.locator(".cr-evidence a").getAttribute("rel")).toBe("noopener noreferrer");
    // The approved design keeps the author's destructive/edit actions behind
    // an overflow disclosure. Opening or dismissing it is entirely local.
    for (const width of [1280, 520]) {
      await real.setViewportSize({ width, height: 900 });
      const message = real.locator(".cr-message").first();
      const menu = message.locator(".cr-message-options");
      const summary = menu.locator("summary");
      expect(await message.locator("[data-action=edit]").isVisible()).toBe(false);
      expect(await summary.getAttribute("title")).toContain("neither sends agent work");
      const before = actions.length;
      await summary.focus();
      await real.keyboard.press("Enter");
      expect(await message.locator("[data-action=edit]").isVisible()).toBe(true);
      const bounds = await message.locator(".cr-message-actions").boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect((await summary.boundingBox())!.width).toBe(32);
      expect((await summary.boundingBox())!.height).toBe(32);
      await message.locator("[data-action=delete-message]").focus();
      await real.keyboard.press("Escape");
      expect(await menu.getAttribute("open")).toBeNull();
      expect(await summary.evaluate((el) => el === document.activeElement)).toBe(true);
      expect(actions.length).toBe(before);
    }
    await real.locator(".cr-message-options summary").first().click();
    await real.locator(".cr-message [data-action=edit]").first().click();
    await real.locator("#cr-body").fill("Edited guidance without dispatch");
    await real.locator("[data-action=post]").click();
    await real.waitForFunction(() => document.querySelector(".cr-message-body")?.textContent === "Edited guidance without dispatch");
    expect(store.getThread(ctx, thread.threadId).messages[0].body).toBe("Edited guidance without dispatch");
    await real.locator(".cr-message-options summary").first().click();
    real.once("dialog", (dialog) => dialog.dismiss());
    await real.locator(".cr-message [data-action=delete-message]").first().click();
    expect(store.getThread(ctx, thread.threadId).messages[0].body).toBe("Edited guidance without dispatch");
    expect(await real.locator(".cr-message-options").first().getAttribute("open")).not.toBeNull();
    real.once("dialog", (dialog) => dialog.accept());
    await real.locator(".cr-message [data-action=delete-message]").first().click();
    await real.waitForFunction(() => document.querySelector(".cr-message-body")?.textContent === "Comment deleted");
    expect(await real.locator(".cr-message").first().locator(".cr-message-options").count()).toBe(0);
    expect(store.getThread(ctx, thread.threadId).messages[0].body).toBeNull();
    expect(queued).toBe(0);
    expect(readFileSync(join(root, "src/validation.ts"), "utf8")).toBe(source);
    expect(errors).toEqual([]);
    if (output) writeFileSync(join(output, "measurements.json"), JSON.stringify({ note: "Matching fixtures/palette; paired screenshots require human visual review, not a pixel parity claim.", dimensions }, null, 2));
  } finally { await browser?.close(); server?.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); }
}, 45_000);
