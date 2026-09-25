import { test, expect } from "bun:test";
import { chromium } from "playwright";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { runCr077Scenario } from "./tests/steps/cr077.steps.js";
import { runCr078Scenario } from "./tests/steps/cr078.steps.js";
import { runCr081Scenario } from "./tests/steps/cr081.steps.js";
import { runCr083Scenario } from "./tests/steps/cr083.steps.js";
import { startReviewProvider } from "./provider-fixture.js";
import {
  prepareAddonTestInstance,
  formatPreparedEnvironment,
} from "../../tests/addon-e2e/scripts/prepare-addon-test-instance.ts";
import { preparedInstanceEnvironment } from "../../scripts/run-test-instance.ts";
const enabled = process.env.PICLAW_REVIEW_HOST_TEST === "1";
const hostTest = enabled ? test : test.skip;
hostTest(
  "real Piclaw explorer review persists comments and optionally completes a loopback-provider dispatch",
  async () => {
    const core = process.env.PICLAW_REVIEW_CORE_SOURCE;
    if (!core || !existsSync(join(core, "runtime/src/index.ts")))
      throw Error("Explicit PICLAW_REVIEW_CORE_SOURCE is required.");
    const root = resolve(import.meta.dir, "../..");
    const prepared = prepareAddonTestInstance({
      repoRoot: root,
      runtimeRoot: core,
      env: { PICLAW_ADDON: "code-review" },
      argv: [],
    });
    const paths = prepared.paths;
    let child: ReturnType<typeof spawn> | undefined, browser;
    let catalogServer: ReturnType<typeof Bun.serve> | undefined;
    let log = "";
    const provider =
      process.env.PICLAW_REVIEW_AGENT_TEST === "1"
        ? startReviewProvider({ busyPrelude: process.env.PICLAW_REVIEW_BUSY_TEST === "1" })
        : null;
    try {
      const recovery = process.env.PICLAW_REVIEW_RECOVERY_TEST === "1";
      const busyTarget = process.env.PICLAW_REVIEW_BUSY_TEST === "1";
      const catalogLifecycle = process.env.PICLAW_REVIEW_CATALOG_TEST === "1";
      if (catalogLifecycle && (!recovery || !process.env.PICLAW_REVIEW_PACKAGE_TARBALL))
        throw Error("Catalogue lifecycle checks require recovery flags and a packed tarball.");
      if (busyTarget && (!provider || process.env.PICLAW_REVIEW_AUTH_TEST !== "1"))
        throw Error("Busy-target checks require authenticated and local-agent fixture flags.");
      if (recovery && (!provider || process.env.PICLAW_REVIEW_AUTH_TEST !== "1" || process.env.PICLAW_REVIEW_RESTART_TEST !== "1"))
        throw Error("Recovery checks require authenticated, local-agent and restart fixture flags.");
      // The generic preparer copies peers; package mode exercises the real
      // production tarball and installs dependencies inside the owned fixture.
      const dest = prepared.installed[0]!.destination;
      const tarball = process.env.PICLAW_REVIEW_PACKAGE_TARBALL;
      if (catalogLifecycle) {
        const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball!, "package/package.json"], { encoding: "utf8" }));
        catalogServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/package.tgz") return new Response(Bun.file(tarball!));
          if (url.pathname === "/catalog.json") return Response.json({ version: 1, source: "Disposable loopback fixture", addons: [{
            slug: "code-review", name: manifest.name, version: manifest.version, type: "extension",
            install: { kind: "tarball", spec: url.origin + "/package.tgz" },
          }] });
          return new Response("Not found", { status: 404 });
        } });
      }
      if (tarball) {
        const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
        if (!entries.length || entries.some((entry) => !/^package\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(entry)))
          throw Error("Refusing tarball with unsafe package paths.");
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(dest, { recursive: true });
        execFileSync("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"]);
        execFileSync("bun", ["install", "--production", "--ignore-scripts", "--cwd", dest], {
          env: { PATH: process.env.PATH, HOME: paths.home, BUN_INSTALL_CACHE_DIR: join(paths.root, "bun-cache") },
          stdio: "pipe",
        });
        expect(existsSync(join(dest, "runtime.ts"))).toBe(true);
        expect(existsSync(join(dest, "web", "index.ts"))).toBe(true);
        expect(existsSync(join(dest, "tests"))).toBe(false);
      } else {
        rmSync(join(dest, "node_modules"));
        cpSync(join(import.meta.dir, "node_modules"), join(dest, "node_modules"), { recursive: true, dereference: true });
      }
      writeFileSync(
        join(paths.workspace, "review-fixture.ts"),
        "export function check(value: string) {\n  return value.trim();\n}\n",
      );
      const marker = crypto.randomUUID();
      writeFileSync(join(paths.workspace, "fixture-owner.txt"), marker);
      // A browser-only fixture must not trigger first-workspace Dream inference.
      mkdirSync(join(paths.workspace, "notes/memory"), { recursive: true });
      for (const name of ["MEMORY.md", "current-state.md", "recent-context.md"])
        writeFileSync(
          join(paths.workspace, "notes/memory", name),
          "# Disposable fixture\n",
        );
      writeFileSync(
        join(paths.workspace, "notes/memory/.dream-state"),
        "version: 1\ninitialized: true\nrecovery: complete\n",
      );
      const authenticated = process.env.PICLAW_REVIEW_AUTH_TEST === "1";
      if (authenticated) {
        // This TOTP fixture is local-only; no credential from the parent environment is used.
        writeFileSync(join(paths.workspace, ".piclaw", "config.json"), JSON.stringify({
          sessionAutoRotate: true, web: { totpSecret: "ORSXG5A" },
        }));
      }
      writeFileSync(
        join(paths.profile, "settings.json"),
        JSON.stringify({
          packages: [],
          extensions: [],
          defaultProvider: provider ? "review-local" : "fixture-unconfigured",
          defaultModel: provider ? "review-fixture" : "none",
        }),
      );
      if (provider)
        writeFileSync(
          join(paths.profile, "models.json"),
          JSON.stringify({
            providers: {
              "review-local": {
                baseUrl: provider.baseUrl,
                api: "openai-completions",
                apiKey: "test-only-local-fixture",
                compat: {
                  supportsDeveloperRole: false,
                  supportsReasoningEffort: false,
                },
                models: [
                  {
                    id: "review-fixture",
                    input: ["text"],
                    contextWindow: 128000,
                    maxTokens: 1024,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          }),
        );
      const port = await new Promise<number>((resolve, reject) => {
        const socket = createServer();
        socket.once("error", reject);
        socket.listen(0, "127.0.0.1", () => {
          const port = (socket.address() as any).port;
          socket.close((error) => (error ? reject(error) : resolve(port)));
        });
      });
      const safe: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      };
      for (const entry of formatPreparedEnvironment(prepared)) {
        const split = entry.indexOf("=");
        safe[entry.slice(0, split)] = entry.slice(split + 1);
      }
      // Source checkouts may contain ignored sidecars from an older build.
      // Keep fixture assets owned and coherent without touching a live checkout.
      const staticDir = join(paths.root, "static");
      cpSync(join(core, "runtime/web/static"), staticDir, {
        recursive: true,
        filter: (path) => !path.endsWith(".gz") && !path.endsWith(".br"),
      });
      safe.PICLAW_WEB_STATIC_DIR = staticDir;
      safe.PICLAW_WEB_HOST = "127.0.0.1";
      safe.PICLAW_WEB_PORT = String(port);
      safe.PICLAW_E2E_DISPOSABLE = "1";
      safe.PICLAW_DB_IN_MEMORY = "0";
      const uiMode = process.env.PICLAW_REVIEW_UI_MODE || "classic";
      if (!["classic", "visual"].includes(uiMode))
        throw Error("PICLAW_REVIEW_UI_MODE must be classic or visual.");
      safe.PICLAW_WEB_UI_MODE = uiMode;
      const env = preparedInstanceEnvironment(safe),
        url = `http://127.0.0.1:${port}`;
      const startHost = () => spawn(
        "/usr/bin/nice",
        [
          "-n",
          "10",
          process.execPath,
          join(core, "runtime/src/index.ts"),
          "--workspace",
          paths.workspace,
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        { cwd: core, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const bootHost = async () => {
        const running = startHost();
        child = running;
        running.stdout?.on("data", (chunk) => { log = (log + chunk.toString()).slice(-250000); });
        running.stderr?.on("data", (chunk) => { log = (log + chunk.toString()).slice(-250000); });
        for (let i = 0; i < 120; i++) {
          if (running.exitCode !== null || running.signalCode)
            throw Error("Fixture exited: " + log.slice(-6000));
          try {
            const r = await fetch(url + (authenticated ? "/login" : "/workspace/raw?path=fixture-owner.txt"), {
              signal: AbortSignal.timeout(500),
            });
            if (r.ok && (authenticated || (await r.text()) === marker)) return;
          } catch {}
          await Bun.sleep(500);
        }
        throw Error("Fixture did not start: " + log.slice(-6000));
      };
      const stopHost = async () => {
        const previous = child!;
        const exited = new Promise<void>((resolve) => previous.once("exit", () => resolve()));
        process.kill(-previous.pid!, "SIGTERM");
        await Promise.race([exited, Bun.sleep(5000)]);
        if (previous.exitCode === null && !previous.signalCode)
          throw Error("Disposable host did not stop before restart.");
      };
      await bootHost();
      // --workspace overrides PICLAW_DATA in the core path resolver.
      const reviewDb = join(paths.workspace, ".piclaw", "data", "addons", "code-review", "reviews.db");
      let sessionCookie: string | undefined;
      if (authenticated) {
        sessionCookie = await runCr077Scenario({
          url, reviewDb, ownerMarker: marker,
          providerRequests: () => provider?.requests.length ?? 0,
        });
      } else {
        // The no-auth host can prove origin denial, but not session denial.
        const foreign = await fetch(url + "/agent/addons/api/code-review/action", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
          body: JSON.stringify({ action: "create", path: "review-fixture.ts", target: { agentName: "worker" }, requestId: "foreign-origin" }),
        });
        expect(foreign.status).toBe(403);
        expect((await foreign.json() as { error?: string }).error).toBe("Origin not allowed");
        expect(existsSync(reviewDb)).toBe(false);
        expect(provider?.requests.length ?? 0).toBe(0);
      }
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PICLAW_REVIEW_TEST_BROWSER || undefined,
        args: ["--no-sandbox"],
        env: {
          PATH: process.env.PATH!,
          HOME: paths.home,
          TMPDIR: paths.tmp,
          XDG_CACHE_HOME: paths.xdgCache,
        },
      });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        ...(process.env.PICLAW_REVIEW_CLASSIC_COPY_TEST === "1" ? { permissions: ["clipboard-read", "clipboard-write"] } : {}),
      });
      if (sessionCookie) {
        const [name, value] = sessionCookie.split("=", 2);
        await context.addCookies([{ name: name!, value: value!, url, httpOnly: true, sameSite: "Strict" }]);
      }
      let page = await context.newPage();
      const browserDestinations: string[] = [];
      const reviewActions: string[] = [];
      page.on("request", (request) => {
        if (/^https?:/.test(request.url())) browserDestinations.push(request.url());
        if (request.url().includes("/agent/addons/api/code-review/action")) reviewActions.push(request.url());
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.log("PAGEERROR", error.message);
      });
      page.on("console", (m) => {
        if (m.type() === "error") console.log("BROWSER ERROR", m.text());
      });
      page.on("response", (r) => {
        if (r.status() >= 400) console.log("HTTPERROR", r.status(), r.url());
      });
      page.on("dialog", (d) => d.accept(d.type() === "prompt" && process.env.PICLAW_REVIEW_CLASSIC_SOURCE_TEST === "1" ? "1" : undefined));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      try {
        await page.waitForFunction(
          () => !!(window as any).__piclaw_web?.workspaceActionsVersion,
          null,
          { timeout: 12000 },
        );
      } catch {
        const capabilities = await page.evaluate(() => Object.keys((window as any).__piclaw_web || {}));
        console.error("Fixture UI diagnostics", await page.evaluate(() => ({ href: location.href, scripts: [...document.scripts].map((s) => s.src).filter(Boolean) })));
        throw Error(`${uiMode} host lacks workspaceActionsVersion; exposed add-on APIs: ${capabilities.join(", ") || "none"}. Review file cannot open until this host surface is implemented.`);
      }
      await page.waitForFunction(
        () => document.querySelector(".workspace-toggle-tab") !== null,
        null,
        { timeout: 60000 },
      );
      // Use the registered public action through real explorer UI when present.
      const file = page.getByText("review-fixture.ts", { exact: true }).first();
      if (!(await file.isVisible())) {
        const toggle = page.getByRole("button", {
          name: "Show workspace",
          exact: true,
        });
        if (await toggle.isVisible()) await toggle.click();
      }
      await file.waitFor({ state: "visible", timeout: 15000 });
      await file.click();
      const action = page
        .getByRole("button", { name: "Review file", exact: true })
        .first();
      if (!(await action.isVisible()))
        await page.getByRole("button", { name: /Workspace actions/i }).click();
      await action.click();
      await page.waitForSelector(".cr-pane .cr-line", { timeout: 30000 });
      expect(
        await page.locator(".cr-pane .cr-file-header").innerText(),
      ).toContain("review-fixture.ts");
      expect(await page.locator(".cr-pane").getAttribute("data-skin")).toBe(uiMode);
      // Browsing the pane must stay on this disposable host and never enqueue
      // agent work before an explicit Send, even with a configured provider.
      expect(browserDestinations.length).toBeGreaterThan(0);
      expect(browserDestinations.every((destination) => new URL(destination).origin === url)).toBe(true);
      expect(provider?.requests.length ?? 0).toBe(0);
      if (process.env.PICLAW_REVIEW_CLASSIC_COPY_TEST === "1") {
        if (uiMode !== "classic") throw Error("Classic copy checks require PICLAW_REVIEW_UI_MODE=classic.");
        const before = readFileSync(join(paths.workspace, "review-fixture.ts"), "utf8");
        const copiedBefore = { requests: reviewActions.length, provider: provider?.requests.length ?? 0 };
        await page.evaluate(() => {
          const first = document.querySelector(".cr-line[data-line='1'] code")!;
          const last = document.querySelector(".cr-line[data-line='3'] code")!;
          const range = document.createRange();
          range.selectNodeContents(first);
          range.setEnd(last, last.childNodes.length);
          const selected = window.getSelection()!;
          selected.removeAllRanges(); selected.addRange(range);
        });
        await page.locator(".cr-source").focus();
        await page.keyboard.press("ControlOrMeta+c");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(before.trimEnd());
        expect(readFileSync(join(paths.workspace, "review-fixture.ts"), "utf8")).toBe(before);
        expect(reviewActions.length).toBe(copiedBefore.requests);
        expect(provider?.requests.length ?? 0).toBe(copiedBefore.provider);
        expect(browserDestinations.every((destination) => new URL(destination).origin === url)).toBe(true);
      }
      await page
        .locator('.cr-pane [data-action=line-comment][data-line="2"]')
        .click();
      await page
        .locator("#cr-body")
        .fill("Validate empty strings before trimming.");
      await page.waitForTimeout(650);
      await page.locator("[data-action=post]").click();
      await page.waitForSelector(".cr-thread", { timeout: 10000 });
      if (await page.locator(".cr-thread [data-action=expand]").getAttribute("aria-expanded") !== "true") await page.locator(".cr-thread [data-action=expand]").click();
      expect(await page.locator(".cr-message-body").innerText()).toContain(
        "Validate empty strings",
      );
      if (authenticated) {
        await runCr078Scenario({
          url, reviewDb, cookie: sessionCookie!,
          providerRequests: () => provider?.requests.length ?? 0,
        });
        await runCr081Scenario({
          url, workspace: paths.workspace, reviewDb, cookie: sessionCookie!,
          providerRequests: () => provider?.requests.length ?? 0,
        });
        await runCr083Scenario({
          url, workspace: paths.workspace, reviewDb, cookie: sessionCookie!,
          providerRequests: () => provider?.requests.length ?? 0,
        });
      }
      {
        const db = new Database(reviewDb, { readonly: true });
        try {
          for (const table of ["dispatches", "attempts"])
            expect((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
        } finally { db.close(); }
      }
      if (provider) {
        if (busyTarget) {
          const db = new Database(reviewDb, { readonly: true });
          let chatId: string;
          try { chatId = JSON.parse((db.query("SELECT target_json FROM reviews LIMIT 1").get() as { target_json: string }).target_json).chatId; }
          finally { db.close(); }
          const started = await fetch(url + "/agent/default/message?chat_jid=" + encodeURIComponent(chatId), {
            method: "POST", headers: { "Content-Type": "application/json", Origin: url, Cookie: sessionCookie! },
            body: JSON.stringify({ content: "CODE_REVIEW_BUSY_FIXTURE: complete this prior local work first.", mode: "queue" }),
          });
          expect(started.ok).toBe(true);
          for (let i = 0; i < 100 && !provider.busyStarted; i++) await Bun.sleep(100);
          expect(provider.busyStarted).toBe(true);
          expect(provider.busyFinished).toBe(false);
        }
        await page.locator(".cr-thread [data-pick]").check();
        expect(provider.requests).toHaveLength(0);
        await page.locator(".cr-pane [data-action=send]").click();
        await page.waitForSelector(".cr-drawer");
        expect(provider.requests).toHaveLength(0);
        await page.locator("[data-action=confirm-send]").click();
        await page.waitForFunction(
          () =>
            document
              .querySelector(".cr-status")
              ?.textContent?.includes("accepted"),
          { timeout: 15000 },
        );
        if (busyTarget) {
          // Acceptance while prior work is held must neither steer nor start
          // the review. Release only after observing the durable queued state.
          await page.waitForTimeout(500);
          expect(provider.busyFinished).toBe(false);
          expect(provider.busyAborted).toBe(false);
          expect(provider.requests).toHaveLength(0);
          const db = new Database(reviewDb, { readonly: true });
          try {
            expect((db.query("SELECT state FROM attempts LIMIT 1").get() as { state: string }).state).toBe("accepted");
            expect((db.query("SELECT work_state FROM dispatch_items LIMIT 1").get() as { work_state: string }).work_state).toBe("not_started");
            expect((db.query("SELECT state FROM threads LIMIT 1").get() as { state: string }).state).toBe("open");
          } finally { db.close(); }
          provider.releaseBusy();
        }
        for (let i = 0; i < 100 && !provider.completed; i++)
          await Bun.sleep(500);
        console.log("LOCAL PROVIDER", {
          requests: provider.requests.length,
          toolOffered: provider.offered,
          completed: provider.completed,
        });
        expect(provider.offered).toBe(true);
        expect(provider.completed).toBe(true);
        if (busyTarget) expect(provider.busyFinished).toBe(true);
        // Reload through the UI; never repair expected state via direct database writes.
        await page.reload();
        await page.waitForSelector(".workspace-toggle-tab");
        const show = page.getByRole("button", {
          name: "Show workspace",
          exact: true,
        });
        if (await show.isVisible()) await show.click();
        await page
          .getByText("review-fixture.ts", { exact: true })
          .first()
          .click();
        const again = page
          .getByRole("button", { name: "Review file", exact: true })
          .first();
        if (!(await again.isVisible()))
          await page
            .getByRole("button", { name: "Workspace actions", exact: true })
            .click();
        await again.click();
        await page.waitForSelector(".cr-thread");
        expect(await page.locator(".cr-thread header").innerText()).toContain(
          "resolved",
        );
        if (process.env.PICLAW_REVIEW_RESTART_TEST === "1") {
          const api = async (payload: object) => {
            const response = await fetch(url + "/agent/addons/api/code-review/action", {
              method: "POST",
              headers: { "Content-Type": "application/json", Origin: url, ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
              body: JSON.stringify(payload),
            });
            expect(response.status).toBe(200);
            const body = await response.json() as { ok: boolean; result: any };
            expect(body.ok).toBe(true);
            return body.result;
          };
          let recoveryState: { reviewId: string; threadId: string; receipt: any; draft: any; messages: any[]; requests: number } | undefined;
          const draftBody = "Private draft retained across cold restart and package removal";
          const deletedBody = "Deleted reply must never return after reinstall";
          if (recovery) {
            const review = (await api({ action: "list", limit: 10 }))[0];
            const thread = (await api({ action: "threads", reviewId: review.id }))[0];
            const reply = await api({ action: "reply", threadId: thread.id, body: deletedBody,
              expectedVersion: thread.version, reopen: true, requestId: "recovery-reply" });
            await api({ action: "deleteMessage", messageId: reply.messageId, expectedVersion: 1,
              confirm: true, requestId: "recovery-delete" });
            const changed = await api({ action: "thread", threadId: thread.id });
            await api({ action: "resolve", threadId: thread.id, fileId: changed.source.fileId,
              expectedVersion: changed.version, explanation: "Recovery fixture keeps the concern resolved", requestId: "recovery-resolve" });
            const receipt = await api({ action: "replyReceipt", reviewId: review.id, threadId: thread.id, requestId: "recovery-reply" });
            expect(receipt).toEqual({ committed: true, threadId: thread.id, messageId: reply.messageId });
            // Save through the real composer, wait for durable acknowledgement.
            await page.locator("[data-action=file-comment]").click();
            await page.locator("#cr-body").fill(draftBody);
            await page.locator("#cr-body").press("ControlOrMeta+s");
            await page.waitForFunction(() => document.querySelector(".cr-composer small")?.textContent === "Draft saved");
            const drafts = await api({ action: "drafts", reviewId: review.id });
            expect(drafts).toHaveLength(1);
            expect(drafts[0].body).toBe(draftBody);
            const savedThread = await api({ action: "thread", threadId: thread.id });
            recoveryState = { reviewId: review.id, threadId: thread.id, receipt, draft: drafts[0], messages: savedThread.messages, requests: provider.requests.length };
          }
          const packageAction = async (action: "uninstall" | "install") => {
            const response = await fetch(url + `/agent/addons/${action}?catalog_url=` + encodeURIComponent(catalogServer!.url.href + "catalog.json"), {
              method: "POST", headers: { "Content-Type": "application/json", Origin: url, Cookie: sessionCookie! },
              body: JSON.stringify({ slug: "code-review" }),
            });
            expect(response.status).toBe(200);
            const result = await response.json() as { ok?: boolean; error?: string };
            if (!result.ok) throw Error(`Fixture ${action} failed: ${result.error}`);
            expect(result.ok).toBe(true);
          };
          // Restart only this owned disposable child; never the live service.
          await page.close();
          if (catalogLifecycle) await packageAction("uninstall");
          await stopHost();
          if (recovery) {
            // Exercise package absence/restoration only in this owned fixture.
            // Opt in separately to the real catalogue manager's lifecycle.
            const savedPackage = join(paths.root, "removed-code-review-package");
            // Hash persisted bytes including WAL after each graceful shutdown;
            // shared-memory lock bookkeeping is not stored review data.
            const digest = () => [reviewDb, reviewDb + "-wal"].map((path) =>
              existsSync(path) ? Bun.hash(readFileSync(path)).toString() : null);
            const retainedDigest = digest();
            if (!catalogLifecycle) renameSync(dest, savedPackage);
            expect(existsSync(dest)).toBe(false);
            await bootHost();
            const absent = await fetch(url + "/agent/addons/api/code-review/action", {
              method: "POST", headers: { "Content-Type": "application/json", Origin: url, Cookie: sessionCookie! },
              body: JSON.stringify({ action: "list", limit: 10 }),
            });
            // Legacy hosts use 500/unknown-command; a proper missing-route 404
            // also satisfies this check. Neither may execute or return data.
            expect([404, 500]).toContain(absent.status);
            const missing = await absent.json() as { ok?: boolean; error?: string; result?: unknown };
            expect(missing.ok).not.toBe(true);
            expect(missing.result).toBeUndefined();
            if (absent.status === 500) expect(missing.error).toContain("Unknown command: /code-review-action-set");
            if (catalogLifecycle) {
              await packageAction("install");
              expect(existsSync(join(dest, "runtime.ts"))).toBe(true);
              expect(existsSync(join(dest, "web", "pane.ts"))).toBe(true);
            }
            await stopHost();
            expect(digest()).toEqual(retainedDigest);
            expect(provider.requests.length).toBe(recoveryState!.requests);
            if (!catalogLifecycle) renameSync(savedPackage, dest);
          }
          await bootHost();
          if (recoveryState) {
            const { reviewId, threadId, receipt, draft, requests } = recoveryState;
            expect(await api({ action: "drafts", reviewId })).toEqual([draft]);
            expect(await api({ action: "replyReceipt", reviewId, threadId, requestId: "recovery-reply" })).toEqual(receipt);
            const thread = await api({ action: "thread", threadId });
            expect(thread.messages).toEqual(recoveryState.messages);
            expect(thread.messages.find((m: any) => m.id === receipt.messageId)).toMatchObject({ deleted: 1, body: null });
            expect(JSON.stringify(thread)).not.toContain(deletedBody);
            expect(JSON.stringify(thread)).not.toContain(draftBody);
            expect(provider.requests.length).toBe(requests);
            const db = new Database(reviewDb, { readonly: true });
            try {
              expect((db.query("SELECT COUNT(*) AS n FROM dispatches").get() as { n: number }).n).toBe(1);
              expect((db.query("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n).toBe(1);
              expect(db.query("SELECT body FROM message_revisions WHERE message_id=? AND body IS NOT NULL").all(receipt.messageId)).toEqual([]);
              expect(JSON.stringify(db.query("SELECT result_json FROM request_receipts").all())).not.toContain(deletedBody);
              expect((db.query("SELECT COUNT(*) AS n FROM request_receipts WHERE request_id='recovery-reply'").get() as { n: number }).n).toBe(1);
            } finally { db.close(); }
          }
          const recovered = await fetch(url + "/agent/addons/api/code-review/action", {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: url, ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
            body: JSON.stringify({ action: "list", limit: 10 }),
          });
          expect(recovered.status).toBe(200);
          const listed = await recovered.json() as { ok: boolean; result?: Array<{ id: string }> };
          expect(listed.ok).toBe(true);
          expect(listed.result).toHaveLength(1);
          page = await context.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("request", (request) => {
            if (/^https?:/.test(request.url())) browserDestinations.push(request.url());
            if (request.url().includes("/agent/addons/api/code-review/action")) reviewActions.push(request.url());
          });
          page.on("dialog", (dialog) => dialog.accept(dialog.type() === "prompt" && (recovery || process.env.PICLAW_REVIEW_CLASSIC_SOURCE_TEST === "1") ? "1" : undefined));
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.waitForSelector(".workspace-toggle-tab");
          const toggle = page.getByRole("button", { name: "Show workspace", exact: true });
          if (await toggle.isVisible()) await toggle.click();
          await page.getByText("review-fixture.ts", { exact: true }).first().click();
          const action = page.getByRole("button", { name: "Review file", exact: true }).first();
          if (!(await action.isVisible())) await page.getByRole("button", { name: "Workspace actions", exact: true }).click();
          await action.click();
          await page.waitForSelector(".cr-thread");
          expect(await page.locator(".cr-thread header").innerText()).toContain("resolved");
          if (await page.locator(".cr-thread [data-action=expand]").getAttribute("aria-expanded") !== "true") await page.locator(".cr-thread [data-action=expand]").click();
          await page.waitForFunction(() => document.querySelector(".cr-message-body")?.textContent?.includes("Validate empty strings"), null, { timeout: 10000 });
          const saved = await page.locator(".cr-message-body").allInnerTexts();
          expect(saved.join("\n")).toContain("Validate empty strings");
          expect(saved.length).toBeGreaterThan(1);
          const db = new Database(reviewDb, { readonly: true });
          try {
            expect((db.query("SELECT state FROM attempts LIMIT 1").get() as { state: string }).state).toBe("accepted");
            expect((db.query("SELECT work_state FROM dispatch_items LIMIT 1").get() as { work_state: string }).work_state).toBe("completed");
          } finally { db.close(); }
          expect(provider.completed).toBe(true);
          if (recoveryState) {
            await page.locator("[data-action=options]").click();
            await page.locator("[data-action=drafts]").click();
            expect(await page.locator("#cr-body").inputValue()).toBe(draftBody);
            expect(provider.requests.length).toBe(recoveryState.requests);
          }
        }
      }
      // Core mode and add-on control layout under owned responsive viewports.
      // No implicit dispatch or source mutation occurs when resizing the pane.
      for (const width of [1024, 520, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.waitForFunction((w) => {
          const pane = document.querySelector<HTMLElement>(".cr-pane");
          return pane && pane.dataset.narrow === String(pane.getBoundingClientRect().width < 720)
            && document.documentElement.clientWidth === w;
        }, width);
        const pane = page.locator(".cr-pane");
        expect(await pane.getAttribute("data-skin")).toBe(uiMode);
        const bounds = await pane.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.width).toBeGreaterThan(250);
        expect(await page.locator(".cr-pane [data-action=send]").first().getAttribute("title")).toBeTruthy();
      }
      if (process.env.PICLAW_REVIEW_CLASSIC_UNTRUSTED_TEST === "1") {
        if (uiMode !== "classic" || !sessionCookie) throw Error("Classic untrusted-content checks require an authenticated Classic fixture.");
        const injected = "<script>window.__reviewScriptRan=1</script>\n\n[unsafe](javascript:alert(1)) [safe](https://example.invalid/evidence)";
        const db = new Database(reviewDb, { readonly: true });
        let reviewId: string, fileId: string, dispatches: number;
        try {
          reviewId = (db.query("SELECT id FROM reviews LIMIT 1").get() as { id: string }).id;
          fileId = (db.query("SELECT id FROM snapshot_files WHERE review_id=? LIMIT 1").get(reviewId) as { id: string }).id;
          dispatches = (db.query("SELECT COUNT(*) AS n FROM dispatches").get() as { n: number }).n;
        } finally { db.close(); }
        const post = await fetch(url + "/agent/addons/api/code-review/action", {
          method: "POST", headers: { "Content-Type": "application/json", Origin: url, Cookie: sessionCookie },
          body: JSON.stringify({ action: "comment", reviewId, fileId, side: "source", range: { startLine: 1, endLine: 1 }, body: injected, requestId: "untrusted-host-comment" }),
        });
        expect(post.status).toBe(200);
        const result = await post.json() as { ok: boolean; result?: { threadId: string } };
        expect(result.ok).toBe(true);
        // The already-mounted pane observes new saved comments on explicit
        // Refresh; no workspace-navigation workaround or background polling.
        await page.locator("[data-action=options]").click();
        await page.locator("[data-action=refresh]").click();
        const thread = page.locator(`#cr-${result.result!.threadId}`);
        await thread.waitFor({ state: "visible" });
        if (await thread.locator("[data-action=expand]").getAttribute("aria-expanded") !== "true") await thread.locator("[data-action=expand]").click();
        await thread.locator(".cr-message-body").waitFor({ state: "visible" });
        expect(await page.evaluate(() => (window as any).__reviewScriptRan)).toBeUndefined();
        expect(await thread.locator("script,iframe,img").count()).toBe(0);
        expect(await thread.locator('a[href^="javascript:"]').count()).toBe(0);
        const link = thread.locator('a[href="https://example.invalid/evidence"]');
        expect(await link.count()).toBe(1);
        expect(await link.getAttribute("rel")).toBe("noopener noreferrer");
        expect(await thread.locator(".cr-message-body").innerText()).toContain("<script>");
        const after = new Database(reviewDb, { readonly: true });
        try { expect((after.query("SELECT COUNT(*) AS n FROM dispatches").get() as { n: number }).n).toBe(dispatches); }
        finally { after.close(); }
        expect(provider?.requests.length ?? 0).toBe(provider ? 7 : 0);
      }
      if (process.env.PICLAW_REVIEW_CLASSIC_UI_TEST === "1") {
        if (uiMode !== "classic") throw Error("Classic UI checks require PICLAW_REVIEW_UI_MODE=classic.");
        await page.setViewportSize({ width: 390, height: 844 });
        const before = new Database(reviewDb, { readonly: true });
        let dispatches: number, threads: number;
        try {
          dispatches = (before.query("SELECT COUNT(*) AS n FROM dispatches").get() as { n: number }).n;
          threads = (before.query("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n;
        } finally { before.close(); }
        for (const line of [1, 3]) {
          await page.locator(`.cr-line [data-action=select-line][data-line="${line}"]`).focus();
          await page.keyboard.press("Enter");
        }
        expect(await page.locator(".cr-selection").innerText()).toContain("source lines 1–3");
        await page.locator("[data-action=range-comment]").focus();
        await page.keyboard.press("Enter");
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("cr-body");
        await page.locator("#cr-body").fill("Keep the three-line range");
        await page.locator("[data-action=post]").focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction((count) => document.querySelectorAll(".cr-thread").length > count, threads);
        const saved = new Database(reviewDb, { readonly: true });
        try {
          const row = saved.query("SELECT t.anchor_json FROM threads t JOIN messages m ON m.thread_id=t.id JOIN message_revisions r ON r.message_id=m.id AND r.version=m.version WHERE r.body='Keep the three-line range' LIMIT 1").get() as { anchor_json: string } | null;
          expect(row).not.toBeNull();
          expect(JSON.parse(row!.anchor_json)).toMatchObject({ scope: "range", startLine: 1, endLine: 3 });
          expect((saved.query("SELECT COUNT(*) AS n FROM dispatches").get() as { n: number }).n).toBe(dispatches);
        } finally { saved.close(); }
        await page.locator("[data-action=threads]").focus();
        await page.keyboard.press("Enter");
        await page.waitForSelector(".cr-drawer");
        expect(await page.locator(".cr-drawer").getAttribute("role")).toBe("dialog");
        const drawer = await page.locator(".cr-drawer").boundingBox();
        const pane = await page.locator(".cr-pane").boundingBox();
        expect(drawer).not.toBeNull(); expect(pane).not.toBeNull();
        expect(drawer!.width).toBeLessThanOrEqual(pane!.width + 1);
        await page.locator(".cr-drawer button").first().focus();
        await page.keyboard.press("Escape");
        expect(await page.locator(".cr-drawer").count()).toBe(0);
        expect(await page.evaluate(() => document.activeElement?.getAttribute("data-action"))).toBe("threads");
        await page.emulateMedia({ forcedColors: "active" });
        expect(await page.locator(".cr-pane [data-action=send]").first().isVisible()).toBe(true);
        expect(await page.locator(".cr-source").isVisible()).toBe(true);
        await page.emulateMedia({ forcedColors: "none" });
      }
      if (process.env.PICLAW_REVIEW_CLASSIC_PHONE_ENTRY_TEST === "1") {
        if (uiMode !== "classic") throw Error("Classic phone entry checks require PICLAW_REVIEW_UI_MODE=classic.");
        const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        try {
          if (sessionCookie) {
            const [name, value] = sessionCookie.split("=", 2);
            await phone.addCookies([{ name: name!, value: value!, url, httpOnly: true, sameSite: "Strict" }]);
          }
          const mobile = await phone.newPage();
          mobile.on("dialog", (dialog) => dialog.accept());
          await mobile.goto(url, { waitUntil: "domcontentloaded" });
          await mobile.getByTestId("hamburger").tap();
          await mobile.getByRole("menuitem", { name: "Show workspace", exact: true }).tap();
          const file = mobile.getByText("review-fixture.ts", { exact: true }).first();
          await file.waitFor({ state: "visible", timeout: 15000 });
          await file.tap();
          const action = mobile.getByRole("button", { name: "Review file", exact: true }).first();
          if (!(await action.isVisible())) await mobile.getByRole("button", { name: "Workspace actions", exact: true }).tap();
          await action.tap();
          await mobile.waitForSelector(".cr-pane .cr-line");
          expect(await mobile.locator(".cr-pane").getAttribute("data-skin")).toBe("classic");
          expect(await mobile.locator(".cr-source").isVisible()).toBe(true);
          expect(await mobile.locator(".cr-pane [data-action=threads]").isVisible()).toBe(true);
          const db = new Database(reviewDb, { readonly: true });
          try { expect((db.query("SELECT COUNT(*) AS n FROM dispatches").get() as { n: number }).n).toBe(provider ? 1 : 0); }
          finally { db.close(); }
        } finally { await phone.close(); }
      }
      if (process.env.PICLAW_REVIEW_CLASSIC_TOUCH_TEST === "1") {
        if (uiMode !== "classic") throw Error("Classic touch checks require PICLAW_REVIEW_UI_MODE=classic.");
        // Exercise touch resize/zoom separately from direct phone entry.
        const touch = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, deviceScaleFactor: 2 });
        try {
          if (sessionCookie) {
            const [name, value] = sessionCookie.split("=", 2);
            await touch.addCookies([{ name: name!, value: value!, url, httpOnly: true, sameSite: "Strict" }]);
          }
          const mobile = await touch.newPage();
          mobile.on("dialog", (dialog) => dialog.accept());
          await mobile.goto(url, { waitUntil: "domcontentloaded" });
          await mobile.waitForSelector(".workspace-toggle-tab", { state: "attached" });
          const show = mobile.getByRole("button", { name: "Show workspace", exact: true });
          if (await show.isVisible()) await show.tap();
          const mobileFile = mobile.getByText("review-fixture.ts", { exact: true }).first();
          await mobileFile.waitFor({ state: "visible", timeout: 10000 });
          await mobileFile.tap();
          const action = mobile.getByRole("button", { name: "Review file", exact: true }).first();
          if (!(await action.isVisible())) await mobile.getByRole("button", { name: "Workspace actions", exact: true }).tap();
          await action.tap();
          await mobile.waitForSelector(".cr-pane .cr-line");
          await mobile.setViewportSize({ width: 390, height: 844 });
          await mobile.evaluate(() => { document.documentElement.style.zoom = "2"; });
          await mobile.waitForFunction(() => document.querySelector<HTMLElement>(".cr-pane")?.dataset.narrow === "true");
          expect(await mobile.locator(".cr-pane [data-action=threads]").isVisible()).toBe(true);
          expect(await mobile.locator(".cr-source").isVisible()).toBe(true);
          await mobile.locator(".cr-pane [data-action=threads]").tap();
          await mobile.waitForSelector(".cr-drawer");
          const bounds = await mobile.locator(".cr-drawer").boundingBox();
          const paneBounds = await mobile.locator(".cr-pane").boundingBox();
          expect(bounds).not.toBeNull(); expect(paneBounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(paneBounds!.x - 1);
          expect(bounds!.width).toBeLessThanOrEqual(paneBounds!.width + 1);
          await mobile.locator(".cr-drawer [data-action=close-drawer]").tap();
          expect(await mobile.locator(".cr-drawer").count()).toBe(0);
          const db = new Database(reviewDb, { readonly: true });
          try {
            expect((db.query("SELECT COUNT(*) AS n FROM dispatches").get() as { n: number }).n).toBe(provider ? 1 : 0);
          } finally { db.close(); }
          expect(provider?.requests.length ?? 0).toBe(provider ? 7 : 0);
        } finally { await touch.close(); }
      }
      if (process.env.PICLAW_REVIEW_CLASSIC_SOURCE_TEST === "1") {
        if (uiMode !== "classic" || !sessionCookie) throw Error("Classic source checks require an authenticated Classic fixture.");
        const git = (...args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], {
          cwd: paths.workspace, encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: paths.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        }).trim();
        const sourcePath = join(paths.workspace, "review-fixture.ts");
        const original = readFileSync(sourcePath, "utf8");
        git("init", "-q");
        writeFileSync(sourcePath, original.replace("value.trim()", "value"));
        git("add", "--", "review-fixture.ts");
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "review baseline");
        const commit = git("rev-parse", "HEAD");
        writeFileSync(sourcePath, original);
        await page.locator("[data-action=options]").click();
        await page.locator("[data-action=refresh]").click();
        await page.waitForFunction(() => !(document.querySelector('#cr-source-mode option[value="commit"]') as HTMLOptionElement)?.disabled);
        const db = new Database(reviewDb, { readonly: true });
        let before: number;
        try { before = (db.query("SELECT COUNT(*) AS n FROM dispatches").get() as { n: number }).n; }
        finally { db.close(); }
        const providerBefore = provider?.requests.length ?? 0;
        const reviewApi = async (payload: object) => {
          const response = await fetch(url + "/agent/addons/api/code-review/action", {
            method: "POST", headers: { "Content-Type": "application/json", Origin: url, Cookie: sessionCookie },
            body: JSON.stringify(payload),
          });
          expect(response.status).toBe(200);
          const result = await response.json() as { ok: boolean; error?: { code: string; message: string }; result?: any };
          expect(result.ok).toBe(true);
          return result.result;
        };
        const history = await reviewApi({ action: "history", path: "review-fixture.ts", limit: 20 });
        expect(history[0]).toMatchObject({ commit, subject: "review baseline" });
        await page.locator("#cr-source-mode").selectOption("commit");
        await page.waitForFunction(() => document.querySelector("#cr-snapshot option:checked")?.textContent?.includes("commit"), null, { timeout: 10000 });
        expect(await page.locator(".cr-pane .cr-file-header").innerText()).toContain("review-fixture.ts");
        await page.locator("#cr-source-mode").selectOption("unstaged");
        await page.waitForFunction(() => document.querySelector("#cr-snapshot option:checked")?.textContent?.includes("unstaged"), null, { timeout: 10000 });
        const review = (await reviewApi({ action: "list", limit: 10 }))[0];
        const snapshots = await reviewApi({ action: "snapshots", reviewId: review.id });
        const latest = snapshots.find((snapshot: any) => snapshot.mode === "unstaged");
        const files = await reviewApi({ action: "files", reviewId: review.id, snapshotId: latest.id });
        expect(files).toHaveLength(1);
        const diff = await reviewApi({ action: "file", reviewId: review.id, fileId: files[0].id, limit: 300 });
        expect(diff.diffTotal).toBeGreaterThan(0);
        expect(JSON.stringify(diff.diff)).toContain("value.trim()");
        expect(readFileSync(sourcePath, "utf8")).toBe(original);
        expect(git("rev-parse", "HEAD")).toBe(commit);
        const after = new Database(reviewDb, { readonly: true });
        try { expect((after.query("SELECT COUNT(*) AS n FROM dispatches").get() as { n: number }).n).toBe(before); }
        finally { after.close(); }
        expect(provider?.requests.length ?? 0).toBe(providerBefore);
      }
      if (process.env.PICLAW_REVIEW_IDLE_TEST === "1") {
        const before = { actions: reviewActions.length, provider: provider?.requests.length ?? 0 };
        const db = new Database(reviewDb, { readonly: true });
        let dispatches: number;
        try { dispatches = (db.query("SELECT COUNT(*) AS n FROM dispatches").get() as { n: number }).n; }
        finally { db.close(); }
        await page.waitForTimeout(65_000);
        expect(reviewActions.length).toBe(before.actions);
        expect(provider?.requests.length ?? 0).toBe(before.provider);
        const after = new Database(reviewDb, { readonly: true });
        try { expect((after.query("SELECT COUNT(*) AS n FROM dispatches").get() as { n: number }).n).toBe(dispatches); }
        finally { after.close(); }
      }
      expect(errors).toEqual([]);
      console.log("REAL HOST PASS", {
        core,
        port,
        uiMode,
        operatorComments: true,
        localFixtureTurns: provider?.requests.length ?? 0,
        priorBusyFixtureTurns: provider?.busyStarted ? 1 : 0,
        catalogUninstallReinstall: catalogLifecycle,
        paidProviderCalls: 0,
      });
    } catch (error) {
      console.error(log.slice(-12000));
      throw error;
    } finally {
      await browser?.close();
      provider?.stop();
      catalogServer?.stop(true);
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        await Promise.race([
          new Promise((r) => child!.once("exit", r)),
          Bun.sleep(3000),
        ]);
        if (child.exitCode === null && !child.signalCode) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
          await new Promise((r) => child!.once("exit", r));
        }
      }
      rmSync(paths.root, { recursive: true, force: true });
    }
  },
  150_000,
);
