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
import { spawn } from "node:child_process";
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
      // The generic preparer copies peers; this add-on also needs its own packaged runtime dependencies.
      const dest = prepared.installed[0]!.destination;
      rmSync(join(dest, "node_modules"));
      cpSync(
        join(import.meta.dir, "node_modules"),
        join(dest, "node_modules"),
        { recursive: true, dereference: true },
      );
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
          const r = await fetch(url + "/workspace/raw?path=fixture-owner.txt", {
            signal: AbortSignal.timeout(500),
          });
          if (r.ok && (await r.text()) === marker) {
            ready = true;
            break;
          }
        } catch {}
        await Bun.sleep(500);
      }
      if (!ready) throw Error("Fixture did not start: " + log.slice(-6000));
      // CR-077: the real host guard rejects a foreign-origin mutation before
      // the add-on handler can create review state or queue agent work.
      const foreign = await fetch(url + "/agent/addons/api/code-review/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ action: "create", path: "review-fixture.ts", target: { agentName: "worker" }, requestId: "foreign-origin" }),
      });
      expect(foreign.status).toBe(403);
      const foreignResult = await foreign.json() as { error?: string };
      expect(foreignResult.error).toBe("Origin not allowed");
      const reviewDb = join(paths.data, "addons", "code-review", "reviews.db");
      expect(existsSync(reviewDb)).toBe(false);
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
      const page = await context.newPage();
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
      if (provider) {
        await page.locator(".cr-thread [data-pick]").check();
        await page.locator(".cr-pane [data-action=send]").click();
        await page.waitForSelector(".cr-drawer");
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
