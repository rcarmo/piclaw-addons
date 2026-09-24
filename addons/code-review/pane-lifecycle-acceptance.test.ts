import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewError, type ReviewIdentity } from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";

const PATH_PREFIX = "piclaw://addon/code-review/";
const HELD_LOAD_ACTIONS = ["review", "targets", "snapshots", "threads", "drafts"];
const DRAFT_BODY = "Unsaved lifecycle draft";

type CountMap = Record<string, number>;
type QueueCall = {
  target: { chatJid: string; incarnation: string };
  content: string;
  mode: "queue";
};
type HeldRequest = {
  action: string;
  settled: boolean;
  settle(): Promise<void>;
  abort(): void;
};
type SeededReview = {
  reviewId: string;
  fileId: string;
  threadId: string;
  dispatchId: string;
};

function increment(counts: CountMap, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

async function waitForCondition(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 25,
) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs)
      throw Error(`Timed out waiting for ${label}.`);
    await Bun.sleep(intervalMs);
  }
}

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

function browserEnv() {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME"])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

async function createHarness(name: string) {
  const root = mkdtempSync(join(tmpdir(), `review-pane-lifecycle-${name}-`));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(
    join(workspace, "sample.ts"),
    "export function validate(name: string) {\n  return name.trim();\n}\n",
  );

  const store = new ReviewService(join(root, "review.db"));
  const ownerId = `owner:${name}`;
  const actorId = `operator:${name}`;
  const workspaceId = `workspace:${name}`;
  const operator: ReviewIdentity = {
    ownerId,
    actorId,
    kind: "operator",
    workspaceId,
  };
  const target = {
    chatJid: `web:worker:${name}`,
    incarnation: `branch:${name}`,
    label: "Implementation",
    agentName: "implementation",
    active: true,
  };
  const queueCalls: QueueCall[] = [];
  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId,
    actorId,
    kind: "operator",
    workspaceRoot: workspace,
    workspaceId,
    async listTargets() {
      return [target];
    },
    async resolveTarget(input) {
      return (
        (input.chatJid === undefined || input.chatJid === target.chatJid) &&
        (input.agentName === undefined || input.agentName === target.agentName) &&
        (input.incarnation === undefined || input.incarnation === target.incarnation)
      )
        ? target
        : null;
    },
    async enqueue(input) {
      queueCalls.push(input);
      return { status: "accepted" as const, rowId: queueCalls.length * 100 };
    },
  };

  const created = await reviewAction(
    ctx,
    "create",
    {
      path: "sample.ts",
      title: "sample.ts",
      target: { chatId: target.chatJid, incarnation: target.incarnation },
      requestId: `${name}-create`,
    },
    store,
  ) as { reviewId: string; files: string[] };
  const fileId = created.files[0]!;
  const commented = await reviewAction(
    ctx,
    "comment",
    {
      reviewId: created.reviewId,
      fileId,
      side: "source",
      range: { startLine: 2, endLine: 2 },
      body: "Already queued guidance",
      requestId: `${name}-comment`,
    },
    store,
  ) as { threadId: string; version: number };
  const dispatch = await reviewAction(
    ctx,
    "send",
    {
      reviewId: created.reviewId,
      target: { chatId: target.chatJid, incarnation: target.incarnation },
      items: [{ threadId: commented.threadId, version: commented.version }],
      requestId: `${name}-send`,
    },
    store,
  ) as { id: string };
  const seeded: SeededReview = {
    reviewId: created.reviewId,
    fileId,
    threadId: commented.threadId,
    dispatchId: dispatch.id,
  };

  const actionCounts: CountMap = {};
  const abortedCounts: CountMap = {};
  let totalActionCalls = 0;
  const holdActions = new Set<string>();
  const heldRequests = new Map<number, HeldRequest>();
  let heldSerial = 0;

  const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}body{display:flex;flex-direction:column}main{flex:1}#controls{display:flex;gap:8px;padding:8px}#pane{height:100%}</style></head><body><div id="controls"><button id="open-review">Open review</button><button id="dispose-review">Dispose review</button></div><main id="pane"></main><script>(()=>{const metrics=window.__paneLifecycleMetrics={storageAdds:0,storageRemoves:0,activeStorageListeners:0,resizeConstructs:0,resizeDisconnects:0,activeResizeObservers:0};const storageListeners=new Set();const nativeAdd=EventTarget.prototype.addEventListener;EventTarget.prototype.addEventListener=function(type,listener,options){if(this===window&&type==="storage"){metrics.storageAdds+=1;if(listener)storageListeners.add(listener);metrics.activeStorageListeners=storageListeners.size}return nativeAdd.call(this,type,listener,options)};const nativeRemove=EventTarget.prototype.removeEventListener;EventTarget.prototype.removeEventListener=function(type,listener,options){if(this===window&&type==="storage"){metrics.storageRemoves+=1;if(listener)storageListeners.delete(listener);metrics.activeStorageListeners=storageListeners.size}return nativeRemove.call(this,type,listener,options)};const NativeResizeObserver=window.ResizeObserver;window.ResizeObserver=class{#inner;#connected=true;constructor(callback){metrics.resizeConstructs+=1;metrics.activeResizeObservers+=1;this.#inner=new NativeResizeObserver(callback)}observe(...args){return this.#inner.observe(...args)}unobserve(...args){return this.#inner.unobserve(...args)}disconnect(){if(this.#connected){this.#connected=false;metrics.resizeDisconnects+=1;metrics.activeResizeObservers-=1}return this.#inner.disconnect()}takeRecords(){return this.#inner.takeRecords()}}})();let pane;window.__codeReviewReady=false;window.__piclaw_web={workspaceActionsVersion:1,registerPane(entry){pane=entry;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(context){window.instance=pane.mount(document.getElementById("pane"),{path:context.path,mode:"view"});return true}};window.__openReview=()=>window.__piclaw_web.openPane({path:${JSON.stringify(PATH_PREFIX + seeded.reviewId)}});window.__disposeReview=()=>{window.instance?.dispose();window.instance=null;return true};document.getElementById("open-review").addEventListener("click",()=>window.__openReview());document.getElementById("dispose-review").addEventListener("click",()=>window.__disposeReview());</script><script type="module" src="/web/index.ts"></script></body></html>`;

  async function respond(body: Record<string, unknown>) {
    try {
      return Response.json({
        ok: true,
        result: await reviewAction(ctx, String(body.action), body, store),
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

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/")
        return new Response(shell, {
          headers: { "Content-Type": "text/html" },
        });
      if (["/web/index.ts", "/web/api.ts", "/web/pane.ts", "/web/styles.ts"].includes(path))
        return new Response(
          transpile.transformSync(
            await Bun.file(join(import.meta.dir, path.slice(1))).text(),
          ),
          { headers: { "Content-Type": "text/javascript" } },
        );
      if (path === "/agent/addons/api/code-review/action") {
        const body = await req.json() as Record<string, unknown>;
        const action = String(body.action || "");
        totalActionCalls += 1;
        increment(actionCounts, action);
        if (holdActions.has(action)) {
          return await new Promise<Response>((resolve) => {
            const id = ++heldSerial;
            const entry: HeldRequest = {
              action,
              settled: false,
              settle: async () => {
                if (entry.settled) return;
                entry.settled = true;
                heldRequests.delete(id);
                resolve(await respond(body));
              },
              abort: () => {
                if (entry.settled) return;
                entry.settled = true;
                increment(abortedCounts, action);
                heldRequests.delete(id);
                resolve(new Response(null, { status: 499 }));
              },
            };
            heldRequests.set(id, entry);
            req.signal.addEventListener("abort", entry.abort, { once: true });
          });
        }
        return await respond(body);
      }
      return new Response("Not found", { status: 404 });
    },
  });

  async function launchPage() {
    const browser = await chromium.launch({
      headless: true,
      executablePath: browserExecutable(),
      args: ["--no-sandbox"],
      env: browserEnv(),
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return { browser, context, page, errors };
  }

  return {
    root,
    workspace,
    store,
    server,
    ctx,
    operator,
    seeded,
    queueCalls,
    holdActions,
    launchPage,
    actionCounts: () => ({ ...actionCounts }),
    abortedCounts: () => ({ ...abortedCounts }),
    totalActionCalls: () => totalActionCalls,
    heldCount(action?: string) {
      return [...heldRequests.values()].filter((entry) => !action || entry.action === action)
        .length;
    },
    resetActionMetrics() {
      totalActionCalls = 0;
      for (const key of Object.keys(actionCounts)) delete actionCounts[key];
      for (const key of Object.keys(abortedCounts)) delete abortedCounts[key];
    },
    async releaseHeld(action?: string) {
      for (const entry of [...heldRequests.values()])
        if (!action || entry.action === action) await entry.settle();
    },
    cleanup() {
      for (const entry of [...heldRequests.values()]) entry.abort();
      server.stop(true);
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test(
  "CR-075/089 pane dispose releases lifecycle hooks, aborts held loads, clears draft timers, and never re-enqueues accepted work",
  async () => {
    const harness = await createHarness("lifecycle");
    let browser:
      | Awaited<ReturnType<typeof harness.launchPage>>["browser"]
      | undefined;
    let page: Awaited<ReturnType<typeof harness.launchPage>>["page"] | undefined;
    let errors: string[] = [];
    try {
      expect(harness.queueCalls).toHaveLength(1);
      expect(
        harness.store.inspectDispatch(harness.operator, harness.seeded.dispatchId).attempts,
      ).toEqual([
        expect.objectContaining({ state: "accepted", host_row_id: 100 }),
      ]);

      const launched = await harness.launchPage();
      browser = launched.browser;
      page = launched.page;
      errors = launched.errors;

      await page.goto(harness.server.url.href);
      await page.waitForFunction(() => (window as any).__codeReviewReady === true);

      harness.resetActionMetrics();
      for (const action of HELD_LOAD_ACTIONS) harness.holdActions.add(action);
      await page.locator("#open-review").click();
      await waitForCondition(
        "all held load actions to start",
        () => HELD_LOAD_ACTIONS.every((action) => harness.actionCounts()[action] === 1),
      );
      expect(harness.heldCount()).toBe(HELD_LOAD_ACTIONS.length);

      await page.locator("#dispose-review").click();
      await waitForCondition(
        "held loads to abort",
        () => HELD_LOAD_ACTIONS.every((action) => harness.abortedCounts()[action] === 1),
      );
      expect(await page.locator(".cr-pane").count()).toBe(0);
      expect(await page.evaluate(() => (window as any).__paneLifecycleMetrics)).toEqual(
        expect.objectContaining({
          storageAdds: 1,
          storageRemoves: 1,
          activeStorageListeners: 0,
          resizeConstructs: 1,
          resizeDisconnects: 1,
          activeResizeObservers: 0,
        }),
      );
      const totalAfterAbort = harness.totalActionCalls();
      await Bun.sleep(250);
      expect(harness.totalActionCalls()).toBe(totalAfterAbort);
      harness.holdActions.clear();
      await harness.releaseHeld();

      harness.resetActionMetrics();
      await page.locator("#open-review").click();
      await page.waitForSelector(".cr-line");
      expect(await page.locator(".cr-thread").count()).toBe(1);
      await page.locator('[data-action=line-comment][data-line="2"]').click();
      await page.locator("#cr-body").fill(DRAFT_BODY);
      expect(await page.locator("#cr-body").inputValue()).toBe(DRAFT_BODY);
      const totalBeforeDraftDispose = harness.totalActionCalls();
      const draftCallsBeforeDispose = harness.actionCounts().draft ?? 0;
      await page.locator("#dispose-review").click();
      await Bun.sleep(700);
      expect(await page.locator(".cr-pane").count()).toBe(0);
      expect(harness.totalActionCalls()).toBe(totalBeforeDraftDispose);
      expect(harness.actionCounts().draft ?? 0).toBe(draftCallsBeforeDispose);
      expect(
        harness.store
          .listDrafts(harness.operator, harness.seeded.reviewId)
          .some((draft: any) => draft.body === DRAFT_BODY),
      ).toBe(false);
      expect(await page.evaluate(() => (window as any).__paneLifecycleMetrics)).toEqual(
        expect.objectContaining({
          storageAdds: 2,
          storageRemoves: 2,
          activeStorageListeners: 0,
          resizeConstructs: 2,
          resizeDisconnects: 2,
          activeResizeObservers: 0,
        }),
      );

      await page.reload();
      await page.waitForFunction(() => (window as any).__codeReviewReady === true);
      harness.resetActionMetrics();
      await page.locator("#open-review").click();
      await page.waitForSelector(".cr-line");
      expect(harness.queueCalls).toHaveLength(1);
      expect(
        harness.store.inspectDispatch(harness.operator, harness.seeded.dispatchId).attempts,
      ).toEqual([
        expect.objectContaining({ state: "accepted", host_row_id: 100 }),
      ]);
      const totalBeforeFinalDispose = harness.totalActionCalls();
      await page.locator("#dispose-review").click();
      await Bun.sleep(250);
      expect(harness.queueCalls).toHaveLength(1);
      expect(harness.totalActionCalls()).toBe(totalBeforeFinalDispose);
      expect(
        harness.store.inspectDispatch(harness.operator, harness.seeded.dispatchId).attempts,
      ).toEqual([
        expect.objectContaining({ state: "accepted", host_row_id: 100 }),
      ]);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      harness.cleanup();
    }
  },
  45_000,
);
