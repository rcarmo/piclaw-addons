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
    expect(await page.locator("#cr-source-mode").inputValue()).toBe("source");
    expect(await page.locator('#cr-source-mode option[value="commit"]').isDisabled()).toBe(true);
    expect(await page.locator("#cr-snapshot").locator("..").getAttribute("class")).toBe("cr-snapshot-history");
    const untitled = async () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cr-pane button,.cr-pane select,.cr-pane textarea,.cr-pane input")]
      .filter((el) => !el.hasAttribute("title") || !el.title.trim())
      .map((el) => `${el.tagName.toLowerCase()}#${el.id}[${el.getAttribute("data-action") ?? ""}]`));
    const unnamed = async () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cr-pane button,.cr-pane input")]
      .filter((el) => !el.getAttribute("aria-label")?.trim() && !el.closest("label") && !el.textContent?.trim() && !el.getAttribute("title")?.trim())
      .map((el) => `${el.tagName.toLowerCase()}#${el.id}[${el.getAttribute("data-action") ?? ""}]`));
    expect(await untitled()).toEqual([]);
    expect(await unnamed()).toEqual([]);
    expect(await page.locator(".cr-toolbar [data-action=send]").isDisabled()).toBe(true);
    expect(await page.locator(".cr-toolbar [data-action=send]").getAttribute("title")).toContain("Include at least one open thread");
    await page.locator('[data-action=line-comment][data-line="2"]').click();
    await page.locator("#cr-body").fill("Reject an empty name first.");
    await page.waitForTimeout(650);
    await page.locator("[data-action=post]").click();
    await page.waitForSelector(".cr-thread", { timeout: 5000 });
    expect(await untitled()).toEqual([]);
    expect(await unnamed()).toEqual([]);
    expect(calls).toBe(0);
    expect(store.listReviews(ctx)).toHaveLength(1);
    const review = store.listReviews(ctx)[0]!;
    expect(store.listThreads(ctx, review.id)).toHaveLength(1);
    expect(await page.locator(".cr-thread .cr-message").innerText()).toContain("Reject an empty name first.");
    expect(await page.locator(".cr-thread .cr-delivery").innerText()).toBe("Not sent");
    const checkbox = page.locator(".cr-thread [data-pick]");
    expect(await checkbox.getAttribute("title")).toContain("next review sent to the agent");
    await checkbox.check();
    expect(await page.locator(".cr-toolbar [data-action=send]").isDisabled()).toBe(false);
    expect(await page.locator(".cr-toolbar [data-action=send]").getAttribute("title")).toContain("Preview selected guidance");
    expect(calls).toBe(0);
    await page.locator("[data-action=send]").click();
    await page.waitForSelector(".cr-drawer");
    expect(await page.locator(".cr-drawer .cr-thread-path").innerText()).toBe("sample.ts");
    expect(await page.locator(".cr-drawer .cr-thread-summary").innerText()).toBe("Reject an empty name first.");
    expect(await untitled()).toEqual([]);
    expect(await unnamed()).toEqual([]);
    expect(await page.locator("[data-action=confirm-send]").getAttribute("title")).toContain("Queue one review");
    expect(calls).toBe(0);
    await page.locator("[data-action=confirm-send]").click();
    await page.waitForFunction(() =>
      document.querySelector(".cr-status")?.textContent?.includes("accepted"),
    );
    expect(calls).toBe(1);
    await page.waitForFunction(() => document.querySelector(".cr-thread .cr-delivery")?.textContent === "Queued");
    expect(await page.locator(".cr-toolbar [data-action=send]").isDisabled()).toBe(true);
    expect(await page.locator(".cr-toolbar [data-action=send]").getAttribute("title")).toContain("Include at least one open thread");
    expect(await untitled()).toEqual([]);
    if (await page.locator(".cr-thread [data-action=expand]").getAttribute("aria-expanded") !== "true") await page.locator(".cr-thread [data-action=expand]").click();
    await page.locator(".cr-message-body").waitFor({ state: "visible" });
    expect(await page.locator(".cr-thread [data-action=send-thread]").getAttribute("title")).toContain("Preview this concern");
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
    // CR-018/094: a failed draft acknowledgement must block pane detach,
    // retain the text and retry with its original request identity.
    await page.route("**/agent/addons/api/code-review/action", async (route) => {
      const payload = JSON.parse(route.request().postData() || "{}");
      if (payload.action === "draft")
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: { code: "storage_unavailable", message: "Draft save failed." } }),
        });
      else await route.continue();
    });
    await page.locator("#cr-body").fill("Keep this text after the failed write.");
    await page.waitForFunction(() => document.querySelector(".cr-status")?.textContent?.includes("Draft save failed"));
    expect(await page.evaluate(() => (window as any).instance.isDirty())).toBe(true);
    const result = await page.evaluate(async () => {
      try {
        await (window as any).instance.beforeDetachFromHost();
        return "detached";
      } catch (error) { return (error as Error).message; }
    });
    expect(result).toContain("Save or explicitly discard");
    expect(await page.locator("#cr-body").inputValue()).toBe("Keep this text after the failed write.");
    expect(store.listDrafts(ctx, review.id).some((d: any) => d.body === "Keep this text after the failed write.")).toBe(false);
    await page.unroute("**/agent/addons/api/code-review/action");
    await page.locator("#cr-body").press("ControlOrMeta+s");
    await page.waitForFunction(() => document.querySelector(".cr-composer small")?.textContent === "Draft saved");
    expect(store.listDrafts(ctx, review.id).some((d: any) => d.body === "Keep this text after the failed write.")).toBe(true);
    expect(await page.evaluate(async () => { await (window as any).instance.beforeDetachFromHost(); return (window as any).instance.isDirty(); })).toBe(false);
    // CR-069: the server commits a reply but the browser loses its response.
    // Retrying the same composer uses its original request ID and never sends work.
    const firstThreadId = store.listThreads(ctx, review.id)[0]!.id;
    if (await page.locator(".cr-thread [data-action=expand]").first().getAttribute("aria-expanded") !== "true") await page.locator(".cr-thread [data-action=expand]").first().click();
    await page.locator(".cr-thread [data-action=reply]").first().click();
    await page.locator("#cr-body").fill("One reply despite a lost acknowledgement.");
    await page.waitForFunction(() => document.querySelector(".cr-composer small")?.textContent === "Draft saved");
    let committedReply = 0;
    await page.route("**/agent/addons/api/code-review/action", async (route) => {
      const payload = JSON.parse(route.request().postData() || "{}");
      if (payload.action === "reply") {
        committedReply++;
        await reviewAction(ctx, payload.action, payload, store);
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: { message: "Reply response lost." } }),
        });
      } else await route.continue();
    });
    await page.locator("[data-action=post]").click();
    await page.waitForFunction(() => document.querySelector(".cr-status")?.textContent?.includes("Reply response lost"));
    expect(committedReply).toBe(1);
    expect(store.getThread(ctx, firstThreadId).messages.filter((m: any) => m.body === "One reply despite a lost acknowledgement.")).toHaveLength(1);
    expect(await page.locator("#cr-body").inputValue()).toBe("One reply despite a lost acknowledgement.");
    await page.unroute("**/agent/addons/api/code-review/action");
    await page.reload();
    await page.locator("#review").click();
    await page.waitForSelector(".cr-pending-reply [data-action=reconcile-reply]");
    expect(await page.locator("#cr-body").count()).toBe(0);
    await page.locator(".cr-pending-reply [data-action=reconcile-reply]").click();
    await page.waitForFunction(() => document.querySelector(".cr-status")?.textContent?.includes("Reply committed"));
    expect(await page.locator(".cr-pending-reply").count()).toBe(0);
    expect(store.getThread(ctx, firstThreadId).messages.filter((m: any) => m.body === "One reply despite a lost acknowledgement.")).toHaveLength(1);
    expect(await page.locator("#cr-body").count()).toBe(0);
    expect(store.listDrafts(ctx, review.id).some((d: any) => d.body === "One reply despite a lost acknowledgement.")).toBe(false);
    // A new tab has a separate pane instance but sees the pending marker.
    await page.locator(".cr-files [data-action=file]").filter({ hasText: "sample.ts" }).click();
    const earlyTab = await context.newPage();
    earlyTab.on("dialog", (dialog) => dialog.accept());
    await earlyTab.goto(server.url.href);
    await earlyTab.waitForFunction(() => !!(window as any).__piclaw_web?.workspaceActionsVersion && document.querySelector<HTMLButtonElement>("#review")?.onclick !== null);
    await earlyTab.locator("#review").click();
    await earlyTab.waitForSelector(".cr-line");
    if (await page.locator(".cr-thread [data-action=expand]").first().getAttribute("aria-expanded") !== "true") await page.locator(".cr-thread [data-action=expand]").first().click();
    await page.locator(".cr-thread [data-action=reply]").first().click();
    await page.locator("#cr-body").fill("Cross-tab acknowledgement was lost.");
    await page.waitForFunction(() => document.querySelector(".cr-composer small")?.textContent === "Draft saved");
    await page.route("**/agent/addons/api/code-review/action", async (route) => {
      const payload = JSON.parse(route.request().postData() || "{}");
      if (payload.action === "reply") {
        await reviewAction(ctx, payload.action, payload, store);
        await route.fulfill({ status: 503, contentType: "application/json",
          body: JSON.stringify({ ok: false, error: { message: "Reply response lost again." } }) });
      } else await route.continue();
    });
    await page.locator("[data-action=post]").click();
    await page.waitForFunction(() => document.querySelector(".cr-status")?.textContent?.includes("Reply response lost again"));
    const pendingMarker = await page.evaluate((id: string) => localStorage.getItem(`piclaw.code-review.pending-reply.${id}`), review.id);
    expect(pendingMarker).toContain(firstThreadId);
    await earlyTab.waitForSelector(".cr-pending-reply [data-action=reconcile-reply]");
    await page.unroute("**/agent/addons/api/code-review/action");
    await earlyTab.locator(".cr-pending-reply [data-action=reconcile-reply]").click();
    await earlyTab.waitForFunction(() => document.querySelector(".cr-status")?.textContent?.includes("Reply committed"));
    await earlyTab.close();
    const otherPage = await context.newPage();
    try {
      otherPage.on("dialog", (dialog) => dialog.accept());
      await otherPage.goto(server.url.href);
      expect(await otherPage.evaluate((id: string) => localStorage.getItem(`piclaw.code-review.pending-reply.${id}`), review.id)).toBeNull();
      await otherPage.waitForFunction(() => !!(window as any).__piclaw_web?.workspaceActionsVersion && document.querySelector<HTMLButtonElement>("#review")?.onclick !== null);
      await otherPage.locator("#review").click();
      expect(await otherPage.locator(".cr-pending-reply").count()).toBe(0);
      expect(store.getThread(ctx, firstThreadId).messages.filter((m: any) => m.body === "Cross-tab acknowledgement was lost.")).toHaveLength(1);
      expect(store.listDrafts(ctx, review.id).some((d: any) => d.body === "Cross-tab acknowledgement was lost.")).toBe(false);
    } finally { await otherPage.close(); }
    // The stale first tab must reconcile before a different reply can be sent.
    await page.locator(".cr-thread [data-action=reply]").first().click();
    await page.locator("#cr-body").fill("Fresh reply after cross-tab reconciliation.");
    await page.waitForFunction(() => document.querySelector(".cr-composer small")?.textContent === "Draft saved");
    await page.locator("[data-action=post]").click();
    await page.waitForFunction(() => document.querySelector(".cr-status")?.textContent?.includes("Comment saved"));
    expect(await page.locator("#cr-body").count()).toBe(0);
    expect(store.getThread(ctx, firstThreadId).messages.filter((m: any) => m.body === "Cross-tab acknowledgement was lost.")).toHaveLength(1);
    expect(store.getThread(ctx, firstThreadId).messages.filter((m: any) => m.body === "Fresh reply after cross-tab reconciliation.")).toHaveLength(1);
    // A rejected request has no receipt. Reconciliation keeps the acknowledged
    // draft and never queues an automatic resend.
    await page.locator(".cr-thread [data-action=reply]").first().click();
    await page.locator("#cr-body").fill("Never committed reply.");
    await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>("#cr-body")?.value === "Never committed reply.") && document.querySelector(".cr-composer small")?.textContent === "Draft saved");
    for (let n = 0; n < 20 && !store.listDrafts(ctx, review.id).some((d: any) => d.body === "Never committed reply."); n++)
      await Bun.sleep(100);
    expect(store.listDrafts(ctx, review.id).some((d: any) => d.body === "Never committed reply.")).toBe(true);
    await page.route("**/agent/addons/api/code-review/action", async (route) => {
      const payload = JSON.parse(route.request().postData() || "{}");
      if (payload.action === "reply") await route.fulfill({ status: 503,
        contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "Reply rejected." } }) });
      else await route.continue();
    });
    await page.locator("[data-action=post]").click();
    await page.waitForFunction(() => document.querySelector(".cr-status")?.textContent?.includes("Reply rejected"));
    await page.unroute("**/agent/addons/api/code-review/action");
    await page.reload();
    await page.locator("#review").click();
    await page.locator(".cr-pending-reply [data-action=reconcile-reply]").click();
    await page.waitForFunction(() => document.querySelector(".cr-status")?.textContent?.includes("No committed reply found"));
    expect(store.listDrafts(ctx, review.id).some((d: any) => d.body === "Never committed reply.")).toBe(true);
    expect(store.getThread(ctx, firstThreadId).messages.some((m: any) => m.body === "Never committed reply.")).toBe(false);
    await page.evaluate((id: string) => localStorage.setItem(`piclaw.code-review.pending-reply.${id}`, "broken-json"), review.id);
    await page.reload();
    await page.locator("#review").click();
    await page.waitForSelector(".cr-recovery-error [data-action=clear-recovery]");
    expect(await page.locator(".cr-pending-reply").count()).toBe(0);
    await page.locator("[data-action=clear-recovery]").click();
    await page.waitForFunction(() => document.querySelector(".cr-status")?.textContent?.includes("Browser marker cleared"));
    expect(await page.evaluate((id: string) => localStorage.getItem(`piclaw.code-review.pending-reply.${id}`), review.id)).toBeNull();
    expect(store.listDrafts(ctx, review.id).some((d: any) => d.body === "Never committed reply.")).toBe(true);
    // A committed reply may race with another tab deleting or editing its draft.
    // The pane must report the public commit even if draft cleanup conflicts.
    await page.locator(".cr-files [data-action=file]").filter({ hasText: "sample.ts" }).click();
    await page.locator("[data-action=threads]").click();
    await page.locator(".cr-drawer [data-action=jump]").first().click();
    await page.waitForSelector(".cr-thread [data-action=reply]");
    await page.locator(".cr-thread [data-action=reply]").first().click();
    await page.locator("#cr-body").fill("Committed even if cleanup conflicts.");
    for (let n = 0; n < 20 && !store.listDrafts(ctx, review.id).some((d: any) => d.body === "Committed even if cleanup conflicts."); n++)
      await Bun.sleep(100);
    expect(store.listDrafts(ctx, review.id).some((d: any) => d.body === "Committed even if cleanup conflicts.")).toBe(true);
    await page.route("**/agent/addons/api/code-review/action", async (route) => {
      const payload = JSON.parse(route.request().postData() || "{}");
      if (payload.action === "deleteDraft")
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "Draft version changed." } }) });
      else await route.continue();
    });
    await page.locator("[data-action=post]").click();
    await page.waitForFunction(() => document.querySelector(".cr-status")?.textContent?.includes("Comment saved. The draft changed"));
    expect(await page.locator("#cr-body").count()).toBe(0);
    expect(store.getThread(ctx, firstThreadId).messages.filter((m: any) => m.body === "Committed even if cleanup conflicts.")).toHaveLength(1);
    expect(store.listDrafts(ctx, review.id).some((d: any) => d.body === "Committed even if cleanup conflicts.")).toBe(true);
    await page.unroute("**/agent/addons/api/code-review/action");
    expect(calls).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    server?.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
