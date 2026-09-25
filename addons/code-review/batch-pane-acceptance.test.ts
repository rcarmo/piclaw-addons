import { expect, test } from "bun:test";
import { chromium } from "playwright";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ReviewError,
  type LocalTarget,
  type ReviewIdentity,
  type SourceCapture,
} from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";

const PATH_PREFIX = "piclaw://addon/code-review/";
const MAIN_BODY = "Selected main-thread guidance";
const UTIL_BODY = "Selected util-thread guidance";
const OTHER_BODY = "Unselected thread that must stay untouched";
const DRAFT_BODY = "Private draft that must never be dispatched";
const SUMMARY = "Check the selected concerns together.";

let harnessSerial = 0;

type QueueCall = {
  target: { chatJid: string; incarnation: string };
  content: string;
  mode: "queue";
};

function browserExecutable() {
  const explicit =
    process.env.PICLAW_REVIEW_BATCH_TEST_BROWSER ||
    process.env.PICLAW_REVIEW_TEST_BROWSER;
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

function createHarness(name: string) {
  const serial = `${name}-${++harnessSerial}`;
  const root = mkdtempSync(join(tmpdir(), `review-batch-pane-${serial}-`));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "main.ts"),
    "export const main = true;\nexport function keepMain() {\n  return 'main';\n}\n",
  );
  writeFileSync(
    join(workspace, "src", "util.ts"),
    "export function utilFallback() {\n  return 'util';\n}\n",
  );

  const store = new ReviewService(join(root, "review.db"));
  let request = 0;

  const operator: ReviewIdentity = {
    ownerId: `owner:${serial}`,
    actorId: `operator:${serial}`,
    kind: "operator",
    workspaceId: `workspace:${serial}`,
  };
  const target: LocalTarget = {
    chatId: `web:worker:${serial}`,
    incarnation: `chat:${serial}`,
    label: "Implementation",
  };
  const hostTarget = {
    chatJid: target.chatId,
    incarnation: target.incarnation,
    label: target.label,
    agentName: "implementation",
    active: true,
  };
  const mutation = (expectedVersion?: number, requestId?: string) => ({
    requestId: requestId ?? `req:${serial}:${++request}`,
    expectedVersion,
  });
  const capture = (files: SourceCapture["files"]): SourceCapture => ({
    workspaceId: operator.workspaceId!,
    worktreeId: `worktree:${serial}`,
    mode: "source",
    base: null,
    head: null,
    capturedAt: new Date().toISOString(),
    files,
  });

  const review = store.createFromCapture(
    operator,
    {
      title: "Batch pane acceptance",
      focusPath: "src/main.ts",
      target,
    },
    capture([
      {
        oldPath: null,
        newPath: "src/main.ts",
        change: "source",
        oldText: null,
        newText:
          "export const main = true;\nexport function keepMain() {\n  return 'main';\n}\n",
        fileIdentity: `inode:main:${serial}`,
      },
      {
        oldPath: null,
        newPath: "src/util.ts",
        change: "source",
        oldText: null,
        newText: "export function utilFallback() {\n  return 'util';\n}\n",
        fileIdentity: `inode:util:${serial}`,
      },
    ]),
    mutation(),
  );

  const reviewId = review.reviewId;
  const mainFileId = review.files[0]!;
  const utilFileId = review.files[1]!;
  const mainThread = store.createThread(
    operator,
    reviewId,
    {
      fileId: mainFileId,
      side: "source",
      range: { startLine: 1, endLine: 1 },
      body: MAIN_BODY,
    },
    mutation(),
  );
  const utilThread = store.createThread(
    operator,
    reviewId,
    {
      fileId: utilFileId,
      side: "source",
      range: { startLine: 1, endLine: 1 },
      body: UTIL_BODY,
    },
    mutation(),
  );
  const otherThread = store.createThread(
    operator,
    reviewId,
    {
      fileId: mainFileId,
      side: "source",
      range: { startLine: 2, endLine: 2 },
      body: OTHER_BODY,
    },
    mutation(),
  );
  store.saveDraft(
    operator,
    reviewId,
    { threadId: mainThread.threadId, body: DRAFT_BODY },
    mutation(),
  );

  const queueCalls: QueueCall[] = [];
  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: operator.ownerId,
    actorId: operator.actorId,
    kind: "operator",
    workspaceRoot: workspace,
    workspaceId: operator.workspaceId!,
    async listTargets() {
      return [hostTarget];
    },
    async resolveTarget(input) {
      return (
        (input.chatJid === undefined || input.chatJid === hostTarget.chatJid) &&
        (input.agentName === undefined ||
          input.agentName === hostTarget.agentName) &&
        (input.incarnation === undefined ||
          input.incarnation === hostTarget.incarnation)
      )
        ? hostTarget
        : null;
    },
    async enqueue(input) {
      queueCalls.push(input);
      return { status: "accepted" as const, rowId: queueCalls.length * 100 };
    },
  };

  const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:calc(100% - 40px)}</style></head><body><button id="open-review">Open review</button><main id="pane"></main><script>let pane;window.__codeReviewReady=false;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};document.getElementById('open-review').onclick=()=>window.__piclaw_web.openPane({path:${JSON.stringify(PATH_PREFIX + reviewId)}});</script><script type="module" src="/web/index.ts"></script></body></html>`;
  const server = Bun.serve({
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
        try {
          const body = await req.json();
          return Response.json({
            ok: true,
            result: await reviewAction(ctx, body.action, body, store),
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

  const launchPage = async () => {
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME"])
      if (process.env[key]) env[key] = process.env[key]!;
    const browser = await chromium.launch({
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
    page.on("pageerror", (error) => errors.push(error.message));
    return { browser, page, errors };
  };

  const waitForShell = async (page: any) => {
    await page.goto(server.url.href);
    await page.waitForFunction(
      () =>
        (window as any).__codeReviewReady === true &&
        document.querySelector("#open-review") !== null,
    );
  };

  const openReview = async (page: any) => {
    await page.locator("#open-review").click();
    await page.waitForSelector(".cr-line");
    await page.waitForFunction(
      () =>
        document.querySelector(".cr-file-header strong")?.textContent ===
        "src/main.ts",
    );
  };

  const cleanup = async () => {
    server.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  };

  return {
    store,
    operator,
    target,
    reviewId,
    mainFileId,
    utilFileId,
    mainThreadId: mainThread.threadId,
    utilThreadId: utilThread.threadId,
    otherThreadId: otherThread.threadId,
    queueCalls,
    mutation,
    launchPage,
    waitForShell,
    openReview,
    cleanup,
  };
}


async function openSend(page: any) {
  await page.locator('.cr-toolbar [data-action=send]').click();
  await page.waitForSelector('.cr-drawer [data-action=confirm-send]');
}

test('new and updated discussions across files are discovered automatically; drafts stay private',async()=>{
 const h=createHarness('auto');let browser;
 try{const x=await h.launchPage();browser=x.browser;const page=x.page;await h.waitForShell(page);await h.openReview(page);
 expect(await page.locator('[data-pick]').count()).toBe(0);expect(await page.locator('.cr-toolbar [data-action=send]').innerText()).toContain('(3)');
 await openSend(page);expect(h.queueCalls).toHaveLength(0);expect(await page.locator('.cr-send-preview li').count()).toBe(3);
 await page.locator('[data-action=confirm-send]').click();await page.waitForFunction(()=>document.querySelector('.cr-status')?.textContent?.includes('Queued'));
 expect(h.queueCalls).toHaveLength(1);const d=h.store.inspectDispatch(h.operator,h.store.listDispatches(h.operator,h.reviewId)[0]!.id);
 expect(new Set(d.items.map((i:any)=>i.thread_id))).toEqual(new Set([h.mainThreadId,h.utilThreadId,h.otherThreadId]));
 expect(JSON.stringify(d)).not.toContain(DRAFT_BODY);expect(h.queueCalls[0]!.content).not.toContain(DRAFT_BODY);
 await page.reload();await h.waitForShell(page);await h.openReview(page);expect(await page.locator('.cr-toolbar [data-action=send]').isDisabled()).toBe(true);expect(h.queueCalls).toHaveLength(1);expect(x.errors).toEqual([]);
 }finally{await browser?.close();await h.cleanup();}
},45000);

test('automatic send excludes another target and never silently reassigns it',async()=>{
 const h=createHarness('target');let browser;
 try{h.store.reassign(h.operator,h.utilThreadId,{chatId:'web:other',incarnation:'b-other',label:'Other'},h.mutation(1));
 const x=await h.launchPage();browser=x.browser;const page=x.page;await h.waitForShell(page);await h.openReview(page);await openSend(page);
 const ids=await page.locator('.cr-send-preview li').evaluateAll((nodes:Element[])=>nodes.map(n=>n.getAttribute('data-preview-thread')));
 expect(ids).not.toContain(h.utilThreadId);expect(ids).toHaveLength(2);expect(h.queueCalls).toHaveLength(0);
 expect(h.store.getThread(h.operator,h.utilThreadId).target.chatId).toBe('web:other');expect(x.errors).toEqual([]);
 }finally{await browser?.close();await h.cleanup();}
},45000);

test('stale in-flight preview cannot reopen a dismissed drawer',async()=>{
 const h=createHarness('preview');let browser;let release=()=>{};
 try{const x=await h.launchPage();browser=x.browser;const page=x.page;await h.waitForShell(page);await h.openReview(page);await openSend(page);
 const gate=new Promise<void>(r=>release=r);let started=()=>{};const start=new Promise<void>(r=>started=r);
 await page.route('**/agent/addons/api/code-review/action',async route=>{if(JSON.parse(route.request().postData()||'{}').action==='preview'){started();await gate;}await route.continue();});
 await page.locator('#cr-target').dispatchEvent('change');await start;await page.locator('button[data-action=close-drawer]').click();release();
 await page.waitForTimeout(150);expect(await page.locator('.cr-drawer').count()).toBe(0);expect(h.queueCalls).toHaveLength(0);expect(x.errors).toEqual([]);
 }finally{release();await browser?.close();await h.cleanup();}
},45000);

test('changed discussion versions require refreshed preview and another explicit confirmation',async()=>{
 const h=createHarness('conflict');let browser;
 try{const x=await h.launchPage();browser=x.browser;const page=x.page;await h.waitForShell(page);await h.openReview(page);await openSend(page);
 h.store.reply(h.operator,h.utilThreadId,'Edited after preview',h.mutation(1));await page.locator('[data-action=confirm-send]').click();
 await page.waitForFunction(()=>document.querySelector('.cr-status')?.textContent?.includes('Guidance changed'));
 expect(h.queueCalls).toHaveLength(0);expect(await page.locator('.cr-send-preview li').count()).toBe(3);
 expect(await page.locator('.cr-send-preview').textContent()).toContain('Guidance v2');
 await page.locator('[data-action=confirm-send]').click();await page.waitForFunction(()=>document.querySelector('.cr-status')?.textContent?.includes('Queued'));expect(h.queueCalls).toHaveLength(1);expect(x.errors).toEqual([]);
 }finally{await browser?.close();await h.cleanup();}
},45000);
