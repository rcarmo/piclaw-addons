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
const SOURCE_PATH = "src/shared.ts";
const FILE_IDENTITY = "inode:shared";
const SNAPSHOT_ONE_TEXT = [
  'export const snapshot = "S1";',
  'export const staleOnly = "late-S1";',
  'export function staleAnchor() {',
  '  return "stale";',
  '}',
].join("\n") + "\n";
const SNAPSHOT_TWO_TEXT = [
  'export const snapshot = "S2";',
  'export const stableOne = "stay on S2";',
  'export const stableTwo = "fresh bytes";',
  'export function liveAnchor() {',
  '  return "fresh";',
  '}',
].join("\n") + "\n";
const SNAPSHOT_ONE_BODY = "S1 thread that must never repaint S2.";
const SNAPSHOT_TWO_BODY = "S2 thread must stay anchored after the switch.";

let harnessSerial = 0;

type ActionBody = {
  action?: string;
  snapshotId?: string;
  fileId?: string;
  threadId?: string;
  [key: string]: unknown;
};

type QueueCall = {
  target: { chatJid: string; incarnation: string };
  content: string;
  mode: "queue";
};

type Hold = {
  started: Promise<ActionBody>;
  release(): Promise<void>;
  waitReleased(): Promise<void>;
};

type Watch = {
  hits(): ActionBody[];
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

function browserEnv() {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME"])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
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

function createHarness(name: string) {
  const serial = `${name}-${++harnessSerial}`;
  const root = mkdtempSync(join(tmpdir(), `review-stale-snapshot-${serial}-`));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, SOURCE_PATH), SNAPSHOT_TWO_TEXT);

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
  const mutation = (expectedVersion?: number) => ({
    requestId: `req:${serial}:${++request}`,
    expectedVersion,
  });
  const capture = (text: string, capturedAt: string): SourceCapture => ({
    workspaceId: operator.workspaceId!,
    worktreeId: `worktree:${serial}`,
    mode: "source",
    base: null,
    head: null,
    capturedAt,
    files: [
      {
        oldPath: null,
        newPath: SOURCE_PATH,
        change: "source",
        oldText: null,
        newText: text,
        fileIdentity: FILE_IDENTITY,
      },
    ],
  });

  const created = store.createFromCapture(
    operator,
    {
      title: "Stale snapshot review",
      focusPath: SOURCE_PATH,
      target,
    },
    capture(SNAPSHOT_ONE_TEXT, "2024-01-01T00:00:01.000Z"),
    mutation(),
  ) as {
    reviewId: string;
    snapshotId: string;
    files: string[];
  };
  const second = store.capture(
    operator,
    created.reviewId,
    capture(SNAPSHOT_TWO_TEXT, "2024-01-01T00:00:02.000Z"),
    mutation(),
  ) as {
    snapshotId: string;
    files: string[];
  };

  const snapshotOneId = created.snapshotId;
  const snapshotTwoId = second.snapshotId;
  const snapshotOneFileId = created.files[0]!;
  const snapshotTwoFileId = second.files[0]!;
  const snapshotOneFile = store.readFile(
    operator,
    created.reviewId,
    snapshotOneFileId,
  );
  const snapshotTwoFile = store.readFile(
    operator,
    created.reviewId,
    snapshotTwoFileId,
  );

  const snapshotOneThread = store.createThread(
    operator,
    created.reviewId,
    {
      fileId: snapshotOneFileId,
      side: "source",
      range: { startLine: 2, endLine: 2 },
      body: SNAPSHOT_ONE_BODY,
    },
    mutation(),
  );
  const snapshotTwoThread = store.createThread(
    operator,
    created.reviewId,
    {
      fileId: snapshotTwoFileId,
      side: "source",
      range: { startLine: 5, endLine: 5 },
      body: SNAPSHOT_TWO_BODY,
    },
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
        (input.agentName === undefined || input.agentName === hostTarget.agentName) &&
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

  const actions: ActionBody[] = [];
  const holds: Array<{
    matcher: (body: ActionBody) => boolean;
    used: boolean;
    body: ActionBody | null;
    resolveStarted(body: ActionBody): void;
    started: Promise<ActionBody>;
    resolveReleased(): void;
    released: Promise<void>;
    settle: (() => Promise<void>) | null;
  }> = [];
  const watches: Array<{ matcher: (body: ActionBody) => boolean; hits: ActionBody[] }> =
    [];

  const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:calc(100% - 40px)}</style></head><body><button id="open-review">Open review</button><main id="pane"></main><script>let pane;window.__codeReviewReady=false;window.__piclaw_web={workspaceActionsVersion:1,registerPane(entry){pane=entry;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};document.getElementById('open-review').onclick=()=>window.__piclaw_web.openPane({path:${JSON.stringify(PATH_PREFIX + created.reviewId)}});</script><script type="module" src="/web/index.ts"></script></body></html>`;

  async function respond(body: ActionBody) {
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
        const body = await req.json() as ActionBody;
        actions.push(body);
        for (const watch of watches)
          if (watch.matcher(body)) watch.hits.push(body);
        const hold = holds.find((entry) => !entry.used && entry.matcher(body));
        if (hold) {
          hold.used = true;
          hold.body = body;
          hold.resolveStarted(body);
          return await new Promise<Response>((resolve) => {
            hold.settle = async () => {
              resolve(await respond(body));
              hold.resolveReleased();
            };
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

  function holdNext(matcher: (body: ActionBody) => boolean): Hold {
    let resolveStarted!: (body: ActionBody) => void;
    let resolveReleased!: () => void;
    const entry = {
      matcher,
      used: false,
      body: null as ActionBody | null,
      started: new Promise<ActionBody>((resolve) => {
        resolveStarted = resolve;
      }),
      resolveStarted,
      released: new Promise<void>((resolve) => {
        resolveReleased = resolve;
      }),
      resolveReleased,
      settle: null as (() => Promise<void>) | null,
    };
    entry.resolveStarted = resolveStarted;
    entry.resolveReleased = resolveReleased;
    holds.push(entry);
    return {
      started: entry.started,
      async release() {
        if (!entry.settle) throw Error("Held request never started.");
        await entry.settle();
      },
      waitReleased() {
        return entry.released;
      },
    };
  }

  function watchFor(matcher: (body: ActionBody) => boolean): Watch {
    const watch = { matcher, hits: [] as ActionBody[] };
    watches.push(watch);
    return { hits: () => [...watch.hits] };
  }

  async function waitForAction(
    label: string,
    predicate: (body: ActionBody) => boolean,
    count = 1,
  ) {
    await waitForCondition(label, () => actions.filter(predicate).length >= count);
  }

  async function waitForShell(page: any) {
    await page.goto(server.url.href);
    await page.waitForFunction(
      () =>
        (window as any).__codeReviewReady === true &&
        document.querySelector("#open-review") !== null,
    );
  }

  async function nextPaints(page: any) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  }

  async function waitForSnapshotTwo(page: any) {
    await page.waitForFunction(
      (state: {
        snapshotId: string;
        path: string;
        hashPrefix: string;
        otherHashPrefix: string;
        line: number;
        lineText: string;
        presentText: string;
        absentText: string;
        threadId: string;
        absentThreadId: string;
        threadLocation: string;
      }) => {
        const snapshot = (document.querySelector("#cr-snapshot") as HTMLSelectElement | null)
          ?.value;
        const header = document.querySelector(".cr-file-header strong")?.textContent;
        const meta = document.querySelector(".cr-file-header .cr-muted")?.textContent || "";
        const sourceText = document.querySelector(".cr-source")?.textContent || "";
        const line = document.querySelector(
          `.cr-line[data-side="source"][data-line="${state.line}"] code`,
        )?.textContent;
        const thread = document.querySelector(
          `#cr-${state.threadId} .cr-muted`,
        )?.textContent || "";
        return (
          snapshot === state.snapshotId &&
          header === state.path &&
          meta.includes(state.hashPrefix) &&
          !meta.includes(state.otherHashPrefix) &&
          line === state.lineText &&
          sourceText.includes(state.presentText) &&
          !sourceText.includes(state.absentText) &&
          document.querySelector(`#cr-${state.threadId}`) !== null &&
          document.querySelector(`#cr-${state.absentThreadId}`) === null &&
          thread.includes(state.threadLocation)
        );
      },
      {
        snapshotId: snapshotTwoId,
        path: SOURCE_PATH,
        hashPrefix: String(snapshotTwoFile.new_hash).slice(0, 10),
        otherHashPrefix: String(snapshotOneFile.new_hash).slice(0, 10),
        line: 5,
        lineText: '  return "fresh";',
        presentText: 'export const stableTwo = "fresh bytes";',
        absentText: 'export const staleOnly = "late-S1";',
        threadId: snapshotTwoThread.threadId,
        absentThreadId: snapshotOneThread.threadId,
        threadLocation: "source lines 5–5",
      },
    );
  }

  function resetActions() {
    actions.length = 0;
    watches.length = 0;
  }

  async function cleanup() {
    server.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }

  return {
    reviewId: created.reviewId,
    queueCalls,
    snapshotOneId,
    snapshotTwoId,
    snapshotOneFileId,
    snapshotTwoFileId,
    snapshotOneThreadId: snapshotOneThread.threadId,
    snapshotTwoThreadId: snapshotTwoThread.threadId,
    launchPage,
    waitForShell,
    waitForSnapshotTwo,
    waitForAction,
    holdNext,
    watchFor,
    nextPaints,
    resetActions,
    cleanup,
  };
}

for (const mode of ["files", "file"] as const) {
  test(
    `CR-152 stale ${mode} response cannot repaint a newer snapshot`,
    async () => {
      const harness = createHarness(mode);
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      try {
        const launched = await harness.launchPage();
        browser = launched.browser;
        const { page, errors } = launched;

        await harness.waitForShell(page);
        await page.locator("#open-review").click();
        await harness.waitForSnapshotTwo(page);
        expect(harness.queueCalls).toHaveLength(0);

        harness.resetActions();
        const hold = harness.holdNext((body) =>
          body.action === mode &&
          (mode === "files"
            ? body.snapshotId === harness.snapshotOneId
            : body.fileId === harness.snapshotOneFileId),
        );
        const unexpected = harness.watchFor((body) =>
          mode === "files"
            ? (body.action === "file" || body.action === "projection") &&
              body.fileId === harness.snapshotOneFileId
            : body.action === "projection" &&
              body.fileId === harness.snapshotOneFileId,
        );

        if (!(await page.locator("#cr-snapshot").isVisible())) await page.locator(".cr-snapshot-history summary").click();
        await page.locator("#cr-snapshot").selectOption(harness.snapshotOneId);
        await hold.started;
        if (!(await page.locator("#cr-snapshot").isVisible())) await page.locator(".cr-snapshot-history summary").click();        await page.locator("#cr-snapshot").selectOption(harness.snapshotTwoId);
        await harness.waitForAction(
          "fresh snapshot file load",
          (body) => body.action === "file" && body.fileId === harness.snapshotTwoFileId,
        );
        await harness.waitForSnapshotTwo(page);

        await hold.release();
        await hold.waitReleased();
        await harness.nextPaints(page);

        expect(unexpected.hits()).toEqual([]);
        await harness.waitForSnapshotTwo(page);
        expect(harness.queueCalls).toHaveLength(0);
        expect(errors).toEqual([]);
      } finally {
        await browser?.close();
        await harness.cleanup();
      }
    },
    45_000,
  );
}
