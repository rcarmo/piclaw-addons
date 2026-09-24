import { test, expect } from "bun:test";
import { chromium } from "playwright";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
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
    let log = "";
    const provider =
      process.env.PICLAW_REVIEW_AGENT_TEST === "1"
        ? startReviewProvider()
        : null;
    try {
      // The generic preparer copies peers; package mode exercises the real
      // production tarball and installs dependencies inside the owned fixture.
      const dest = prepared.installed[0]!.destination;
      const tarball = process.env.PICLAW_REVIEW_PACKAGE_TARBALL;
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
      child = spawn(
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
      child.stdout?.on("data", (chunk) => {
        log = (log + chunk.toString()).slice(-250000);
      });
      child.stderr?.on("data", (chunk) => {
        log = (log + chunk.toString()).slice(-250000);
      });
      let ready = false;
      for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null || child.signalCode)
          throw Error("Fixture exited: " + log.slice(-6000));
        try {
          const r = await fetch(url + (authenticated ? "/login" : "/workspace/raw?path=fixture-owner.txt"), {
            signal: AbortSignal.timeout(500),
          });
          if (r.ok && (authenticated || (await r.text()) === marker)) {
            ready = true;
            break;
          }
        } catch {}
        await Bun.sleep(500);
      }
      if (!ready) throw Error("Fixture did not start: " + log.slice(-6000));
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
      });
      if (sessionCookie) {
        const [name, value] = sessionCookie.split("=", 2);
        await context.addCookies([{ name: name!, value: value!, url, httpOnly: true, sameSite: "Strict" }]);
      }
      const page = await context.newPage();
      const browserDestinations: string[] = [];
      page.on("request", (request) => {
        if (/^https?:/.test(request.url())) browserDestinations.push(request.url());
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
      page.on("dialog", (d) => d.accept());
      await page.goto(url, { waitUntil: "domcontentloaded" });
      try {
        await page.waitForFunction(
          () => !!(window as any).__piclaw_web?.workspaceActionsVersion,
          null,
          { timeout: 12000 },
        );
      } catch {
        const capabilities = await page.evaluate(() => Object.keys((window as any).__piclaw_web || {}));
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
      await page
        .locator('.cr-pane [data-action=line-comment][data-line="2"]')
        .click();
      await page
        .locator("#cr-body")
        .fill("Validate empty strings before trimming.");
      await page.waitForTimeout(650);
      await page.locator("[data-action=post]").click();
      await page.waitForSelector(".cr-thread", { timeout: 10000 });
      await page.locator(".cr-thread [data-action=expand]").click();
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
        for (let i = 0; i < 100 && !provider.completed; i++)
          await Bun.sleep(500);
        console.log("LOCAL PROVIDER", {
          requests: provider.requests.length,
          toolOffered: provider.offered,
          completed: provider.completed,
        });
        expect(provider.offered).toBe(true);
        expect(provider.completed).toBe(true);
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
      expect(errors).toEqual([]);
      console.log("REAL HOST PASS", {
        core,
        port,
        uiMode,
        operatorComments: true,
        localFixtureTurns: provider?.requests.length ?? 0,
        paidProviderCalls: 0,
      });
    } catch (error) {
      console.error(log.slice(-12000));
      throw error;
    } finally {
      await browser?.close();
      provider?.stop();
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
