import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewError } from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";

const PATH_PREFIX = "piclaw://addon/code-review/";

let harnessSerial = 0;

function browserExecutable() {
  const explicit = process.env.PICLAW_REVIEW_TEST_BROWSER;
  if (explicit) return explicit;
  for (const home of ["/home/agent", process.env.HOME || ""]) {
    if (!home) continue;
    const root = join(home, ".cache", "ms-playwright");
    try {
      for (const dir of readdirSync(root)
        .filter((entry) => entry.startsWith("chromium_headless_shell-"))
        .sort()
        .reverse()) {
        const candidate = join(
          root,
          dir,
          "chrome-headless-shell-linux64",
          "chrome-headless-shell",
        );
        if (existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return undefined;
}

function createHarness() {
  const serial = ++harnessSerial;
  const root = mkdtempSync(join(tmpdir(), `review-historical-pane-${serial}-`));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });

  const gitEnv = {
    PATH: process.env.PATH!,
    HOME: process.env.HOME || root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: workspace,
      env: gitEnv,
      encoding: "utf8",
    }).trim();

  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.autocrlf", "false");

  writeFileSync(join(workspace, "old.ts"), "first\n");
  git("add", "old.ts");
  git("commit", "-qm", "first");
  const firstCommit = git("rev-parse", "HEAD");

  writeFileSync(join(workspace, "old.ts"), "second\n");
  git("add", "old.ts");
  git("commit", "-qm", "second");
  const secondCommit = git("rev-parse", "HEAD");

  git("mv", "old.ts", "renamed.ts");
  git("commit", "-qm", "rename");
  const renameCommit = git("rev-parse", "HEAD");

  writeFileSync(join(workspace, "renamed.ts"), "fourth\n");
  git("add", "renamed.ts");
  git("commit", "-qm", "fourth");
  const headCommit = git("rev-parse", "HEAD");

  const headBefore = git("rev-parse", "HEAD");
  const statusBefore = git("status", "--porcelain=v1");
  const indexBefore = readFileSync(join(workspace, ".git", "index"));
  const renamedBytesBefore = readFileSync(join(workspace, "renamed.ts"));

  const store = new ReviewService(join(root, "review.db"));
  let request = 0;
  const target = {
    chatJid: `web:worker:${serial}`,
    incarnation: `chat:${serial}`,
    agentName: "worker",
    label: "Worker",
    active: true,
  };
  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: `owner:${serial}`,
    actorId: `operator:${serial}`,
    kind: "operator",
    workspaceRoot: workspace,
    workspaceId: `workspace:${serial}`,
    async listTargets() {
      return [target];
    },
    async resolveTarget(input) {
      return (
        (input.chatJid === undefined || input.chatJid === target.chatJid) &&
        (input.agentName === undefined || input.agentName === target.agentName) &&
        (input.incarnation === undefined ||
          input.incarnation === target.incarnation)
      )
        ? target
        : null;
    },
    async enqueue() {
      throw Error("Recent commit browsing must not queue host work.");
    },
  };

  return {
    workspace,
    git,
    store,
    ctx,
    target,
    firstCommit,
    secondCommit,
    renameCommit,
    headCommit,
    headBefore,
    statusBefore,
    indexBefore,
    renamedBytesBefore,
    requestId(label: string) {
      return `req:${serial}:${label}:${++request}`;
    },
    cleanup() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test(
  "CR-091/092 browser history capture follows a rename, keeps Git pristine, and durable historical snapshots reopen",
  async () => {
    const f = createHarness();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const created = (await reviewAction(
        f.ctx,
        "create",
        {
          path: "renamed.ts",
          target: { agentName: f.target.agentName },
          requestId: f.requestId("create"),
        },
        f.store,
      )) as {
        reviewId: string;
        snapshotId: string;
        files: string[];
      };

      const initialSnapshotId = created.snapshotId;
      const actions: any[] = [];
      const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
      const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:calc(100% - 40px)}</style></head><body><button id="open-review">Open review</button><main id="pane"></main><script>window.__codeReviewReady=false;let pane;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};document.getElementById('open-review').onclick=()=>window.__piclaw_web.openPane({path:${JSON.stringify(PATH_PREFIX + created.reviewId)}});</script><script type="module" src="/web/index.ts"></script></body></html>`;
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
            ["/web/index.ts", "/web/api.ts", "/web/pane.ts", "/web/styles.ts"].includes(
              path,
            )
          )
            return new Response(
              transpile.transformSync(
                await Bun.file(join(import.meta.dir, path.slice(1))).text(),
              ),
              { headers: { "Content-Type": "text/javascript" } },
            );
          if (path === "/agent/addons/api/code-review/action") {
            const body = await req.json();
            actions.push(body);
            try {
              return Response.json({
                ok: true,
                result: await reviewAction(f.ctx, body.action, body, f.store),
              });
            } catch (error) {
              const reviewError =
                error instanceof ReviewError
                  ? error
                  : new ReviewError(
                      "failed",
                      (error as Error).message || "Review request failed.",
                      500,
                    );
              return Response.json(
                {
                  ok: false,
                  error: {
                    code: reviewError.code,
                    status: reviewError.status,
                    message: reviewError.message,
                  },
                },
                { status: reviewError.status },
              );
            }
          }
          return new Response("Not found", { status: 404 });
        },
      });

      const env: Record<string, string> = {};
      for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME"])
        if (process.env[key]) env[key] = process.env[key]!;
      browser = await chromium.launch({
        headless: true,
        executablePath: browserExecutable(),
        args: ["--no-sandbox"],
        env,
      });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      const errors: string[] = [];
      let commitPrompt = "";
      const dialogProblems: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("dialog", async (dialog) => {
        const message = dialog.message();
        if (message.includes("Commit number")) {
          commitPrompt = message;
          const line = message
            .split("\n")
            .find((entry) => /\bsecond\b/.test(entry) && entry.includes("· old.ts"));
          const pick = line?.match(/^(\d+)\./)?.[1];
          if (!pick) dialogProblems.push(`Missing pre-rename old.ts entry: ${message}`);
          await dialog.accept(pick ?? "999");
          return;
        }
        dialogProblems.push(`Unexpected dialog: ${message}`);
        await dialog.dismiss();
      });

      await page.goto(server.url.href);
      await page.waitForFunction(
        () =>
          (window as any).__codeReviewReady === true &&
          document.querySelector("#open-review") !== null,
      );
      await page.locator("#open-review").click();
      await page.waitForFunction(
        () =>
          document.querySelector(".cr-file-header strong")?.textContent ===
          "renamed.ts",
      );
      expect(await page.locator(".cr-source").innerText()).toContain("fourth");

      await page.locator("[data-action=options]").click();
      await page.locator("[data-action=history]").click();
      await page.waitForFunction(
        () => document.querySelector("#cr-snapshot option")?.textContent?.includes("commit"),
      );
      await page.waitForFunction(
        () =>
          document.querySelector(".cr-file-header strong")?.textContent === "old.ts",
      );
      expect(dialogProblems).toEqual([]);
      expect(commitPrompt).toContain("rename · renamed.ts ← old.ts");
      expect(commitPrompt).toContain("second · old.ts");

      const captureCall = actions
        .filter((body) => body.action === "capture")
        .at(-1);
      expect(captureCall?.source).toMatchObject({
        path: "old.ts",
        mode: "commit",
        commit: f.secondCommit,
      });

      const snapshots = f.store.listSnapshots(f.ctx, created.reviewId) as Array<{
        id: string;
        mode: string;
        base: string | null;
        head: string | null;
      }>;
      expect(snapshots).toHaveLength(2);
      const historicalSnapshot = snapshots.find(
        (snapshot) => snapshot.mode === "commit",
      );
      expect(historicalSnapshot).toBeTruthy();
      expect(historicalSnapshot).toMatchObject({
        base: f.firstCommit,
        head: f.secondCommit,
      });
      const historicalSnapshotId = historicalSnapshot!.id;
      const historicalFile = f.store.readFile(
        f.ctx,
        created.reviewId,
        f.store.snapshotFiles(f.ctx, created.reviewId, historicalSnapshotId)[0]!.id,
      );
      expect(historicalFile).toMatchObject({
        old_path: "old.ts",
        new_path: "old.ts",
        oldText: "first\n",
        newText: "second\n",
      });
      const historicalUiText = await page.locator(".cr-source").innerText();
      expect(historicalUiText).toContain("second");
      expect(historicalUiText).not.toContain("fourth");

      await page.locator('[data-action=line-comment][data-side="new"][data-line="1"]').click();
      await page.locator("#cr-body").fill("Historical rename comment");
      await page.waitForTimeout(650);
      await page.locator("[data-action=post]").click();
      await page.waitForSelector(".cr-thread", { timeout: 5000 });

      const thread = f.store.listThreads(f.ctx, created.reviewId)[0]!;
      const persisted = f.store.getThread(f.ctx, thread.id);
      expect(persisted.source).toMatchObject({
        snapshotId: historicalSnapshotId,
        oldPath: "old.ts",
        newPath: "old.ts",
        selectedText: "second",
      });
      expect(persisted.anchor).toMatchObject({
        snapshotFileId: persisted.source.fileId,
        side: "new",
        startLine: 1,
        endLine: 1,
      });

      await page.locator("#cr-snapshot").selectOption(initialSnapshotId);
      await page.waitForFunction(
        () =>
          document.querySelector(".cr-file-header strong")?.textContent ===
          "renamed.ts",
      );
      expect(await page.locator(".cr-source").innerText()).toContain("fourth");

      await page.locator("[data-action=threads]").click();
      await page.waitForSelector(".cr-drawer [data-action=jump]");
      await page.locator(".cr-drawer [data-action=jump]").click();
      await page.waitForFunction(
        (snapshotId) =>
          (document.querySelector("#cr-snapshot") as HTMLSelectElement | null)
            ?.value === snapshotId,
        historicalSnapshotId,
      );
      await page.waitForFunction(
        () =>
          document.querySelector(".cr-file-header strong")?.textContent === "old.ts",
      );
      expect(await page.locator(".cr-thread header").first().innerText()).toContain(
        "new lines 1–1",
      );

      await page.reload();
      await page.waitForFunction(
        () =>
          (window as any).__codeReviewReady === true &&
          document.querySelector("#open-review") !== null,
      );
      await page.locator("#open-review").click();
      await page.waitForFunction(
        (snapshotId) =>
          (document.querySelector("#cr-snapshot") as HTMLSelectElement | null)
            ?.value === snapshotId,
        historicalSnapshotId,
      );
      await page.waitForFunction(
        () =>
          document.querySelector(".cr-file-header strong")?.textContent === "old.ts",
      );
      expect(await page.locator(".cr-source").innerText()).toContain("second");
      expect(await page.locator(".cr-thread header").first().innerText()).toContain(
        "new lines 1–1",
      );
      expect(errors).toEqual([]);

      expect(f.git("rev-parse", "HEAD")).toBe(f.headBefore);
      expect(f.git("status", "--porcelain=v1")).toBe(f.statusBefore);
      expect(readFileSync(join(f.workspace, ".git", "index")).equals(f.indexBefore)).toBe(
        true,
      );
      expect(readFileSync(join(f.workspace, "renamed.ts")).equals(f.renamedBytesBefore)).toBe(
        true,
      );
      expect(f.git("rev-parse", "HEAD")).toBe(f.headCommit);
      expect(f.git("rev-parse", `${f.renameCommit}^`)).toBe(f.secondCommit);
    } finally {
      await browser?.close();
      server?.stop(true);
      f.cleanup();
    }
  },
  60_000,
);
