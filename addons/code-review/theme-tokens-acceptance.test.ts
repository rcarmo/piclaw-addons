import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
import { chromium } from "playwright";

import { ReviewError, type ReviewIdentity } from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { reviewAction } from "./runtime.js";

const PATH_PREFIX = "piclaw://addon/code-review/";
const FILE_PATH = "theme.ts";
const THREAD_BODY = "Anchor this thread while host theme tokens change.";
const DRAFT_BODY = "Selection and draft text must survive token-only host theme changes.";
const OLD_TEXT = [
  "export function before(flag: boolean) {",
  '  const note = "dark";',
  "  return flag ? 1 : 0;",
  "}",
].join("\n") + "\n";
const NEW_TEXT = [
  "export function after(flag: boolean) {",
  "  const note = `light`;",
  "  return flag ? 2 : 0;",
  "}",
].join("\n") + "\n";

const DARK_THEME = {
  "--bg-primary": "#0f172a",
  "--bg-secondary": "#172233",
  "--bg-hover": "#22324a",
  "--border-color": "#33506b",
  "--text-primary": "#e2e8f0",
  "--text-secondary": "#94a3b8",
  "--accent-color": "#67e8f9",
  "--accent-contrast-text": "#082f49",
  "--bg-code": "#111827",
  "--text-code": "#dbeafe",
  "--success-color": "#7c7c7c",
  "--danger-color": "#7c7c7c",
  "--syntax-keyword": "#f472b6",
  "--syntax-function": "#93c5fd",
  "--syntax-string": "#86efac",
  "--font-family": "system-ui",
  "--font-family-mono": "monospace",
} as const;

const LIGHT_THEME = {
  "--bg-primary": "#f8fafc",
  "--bg-secondary": "#e2e8f0",
  "--bg-hover": "#dbe4ee",
  "--border-color": "#94a3b8",
  "--text-primary": "#0f172a",
  "--text-secondary": "#475569",
  "--accent-color": "#0f766e",
  "--accent-contrast-text": "#ffffff",
  "--bg-code": "#fff7ed",
  "--text-code": "#1f2937",
  "--success-color": "#7c7c7c",
  "--danger-color": "#7c7c7c",
  "--syntax-keyword": "#7c3aed",
  "--syntax-function": "#0369a1",
  "--syntax-string": "#047857",
  "--font-family": "system-ui",
  "--font-family-mono": "monospace",
} as const;

type QueueCall = {
  target: { chatJid: string; incarnation: string };
  content: string;
  mode: "queue";
};

type ThemeSnapshot = {
  hostTheme: string;
  contextColorScheme: string;
  mountCount: number;
  samePane: boolean;
  paneBg: string;
  expectedPaneBg: string;
  paneText: string;
  expectedPaneText: string;
  sourceBg: string;
  expectedSourceBg: string;
  sourceText: string;
  expectedSourceText: string;
  threadBorder: string;
  expectedBorder: string;
  accent: string;
  expectedAccent: string;
  keyword: string;
  expectedKeyword: string;
  fn: string;
  expectedFn: string;
  string2: string;
  expectedString2: string;
  success: string;
  danger: string;
  addedBg: string;
  expectedAddedBg: string;
  deletedBg: string;
  expectedDeletedBg: string;
  selectedRows: string[];
  draftBody: string;
  threadIds: string[];
  geometry: {
    added: { width: number; height: number; top: number };
    deleted: { width: number; height: number; top: number };
    selected: { width: number; height: number; top: number };
  };
};

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
  const root = mkdtempSync(join(tmpdir(), `review-theme-tokens-${name}-`));
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });

  const env = {
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repoDir,
      env,
      encoding: "utf8",
    }).trim();

  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.autocrlf", "false");

  writeFileSync(join(repoDir, FILE_PATH), OLD_TEXT);
  git("add", FILE_PATH);
  git("commit", "-qm", "base");
  writeFileSync(join(repoDir, FILE_PATH), NEW_TEXT);
  git("add", FILE_PATH);

  const store = new ReviewService(join(root, "review.db"));
  const operator: ReviewIdentity = {
    ownerId: `owner:${name}`,
    actorId: `operator:${name}`,
    kind: "operator",
    workspaceId: `workspace:${name}`,
  };
  const target = {
    chatJid: `web:worker:${name}`,
    incarnation: `chat:${name}`,
    label: "Implementation",
    agentName: "implementation",
    active: true,
  };
  const queueCalls: QueueCall[] = [];
  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: operator.ownerId,
    actorId: operator.actorId,
    kind: "operator",
    workspaceRoot: repoDir,
    workspaceId: operator.workspaceId!,
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
      path: FILE_PATH,
      mode: "staged",
      title: "Theme token acceptance",
      target: { chatId: target.chatJid, incarnation: target.incarnation },
      requestId: `${name}-create`,
    },
    store,
  ) as { reviewId: string; files: string[] };
  const fileId = created.files[0]!;
  const thread = await reviewAction(
    ctx,
    "comment",
    {
      reviewId: created.reviewId,
      fileId,
      side: "new",
      range: { startLine: 2, endLine: 2 },
      body: THREAD_BODY,
      requestId: `${name}-comment`,
    },
    store,
  ) as { threadId: string };

  const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const shell = `<!doctype html><html><head><style>html,body,#host,#pane{height:100%;margin:0}#host{padding:0}</style></head><body><main id="host"><section id="pane"></section></main><script>window.__hostThemes={dark:${JSON.stringify(DARK_THEME)},light:${JSON.stringify(LIGHT_THEME)}};window.__hostColorScheme="light";window.__mountCount=0;window.__paneContext=null;window.__codeReviewReady=false;window.__applyHostTheme=(theme,colorScheme)=>{const host=document.getElementById("host");const vars=window.__hostThemes[theme];for(const [key,value] of Object.entries(vars))host.style.setProperty(key,value);host.dataset.theme=theme;window.__hostColorScheme=colorScheme;if(window.__paneContext)window.__paneContext.colorScheme=colorScheme};window.__applyHostTheme("dark","light");let pane;window.__piclaw_web={workspaceActionsVersion:1,registerPane(entry){pane=entry;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(context){window.__mountCount+=1;window.__paneContext={path:context.path,mode:"view",colorScheme:window.__hostColorScheme};window.instance=pane.mount(document.getElementById("pane"),window.__paneContext);return true}};window.__snapshotThemeState=()=>{const host=document.getElementById("host");const pane=document.querySelector(".cr-pane");const source=document.querySelector(".cr-source");const thread=document.querySelector(".cr-thread");const added=document.querySelector('.cr-line.added[data-side="new"][data-line="2"]');const deleted=document.querySelector('.cr-line.deleted[data-side="old"][data-line="2"]');const selected=document.querySelector('.cr-line.selected[data-side="new"][data-line="2"]');const keyword=document.querySelector('.cr-line.added[data-side="new"][data-line="1"] .tok-keyword');const fn=document.querySelector('.cr-line.added[data-side="new"][data-line="1"] .tok-variableName.tok-definition.tok-function');const string2=document.querySelector('.cr-line.added[data-side="new"][data-line="2"] .tok-string2');const accent=document.querySelector('.cr-line[data-side="new"][data-line="2"] > button');const resolveColor=(expr)=>{const probe=document.createElement("div");probe.style.color=expr;host.append(probe);const value=getComputedStyle(probe).color;probe.remove();return value};const resolveBackground=(expr)=>{const probe=document.createElement("div");probe.style.background=expr;host.append(probe);const value=getComputedStyle(probe).backgroundColor;probe.remove();return value};const rect=(node)=>{const box=node.getBoundingClientRect();return {width:box.width,height:box.height,top:box.top}};return {hostTheme:host.dataset.theme||"",contextColorScheme:window.__paneContext?.colorScheme||"",mountCount:window.__mountCount,samePane:document.querySelector(".cr-pane")===window.__initialPane,paneBg:getComputedStyle(pane).backgroundColor,expectedPaneBg:resolveBackground("var(--bg-primary)"),paneText:getComputedStyle(pane).color,expectedPaneText:resolveColor("var(--text-primary)"),sourceBg:getComputedStyle(source).backgroundColor,expectedSourceBg:resolveBackground("var(--bg-code)"),sourceText:getComputedStyle(source).color,expectedSourceText:resolveColor("var(--text-code)"),threadBorder:getComputedStyle(thread).borderTopColor,expectedBorder:resolveColor("var(--border-color)"),accent:getComputedStyle(accent).color,expectedAccent:resolveColor("var(--accent-color)"),keyword:getComputedStyle(keyword).color,expectedKeyword:resolveColor("var(--syntax-keyword)"),fn:getComputedStyle(fn).color,expectedFn:resolveColor("var(--syntax-function)"),string2:getComputedStyle(string2).color,expectedString2:resolveColor("var(--syntax-string)"),success:resolveColor("var(--success-color)"),danger:resolveColor("var(--danger-color)"),addedBg:getComputedStyle(added).backgroundColor,expectedAddedBg:resolveBackground("color-mix(in srgb, #2da44e 14%, var(--bg-code,var(--bg-primary)))"),deletedBg:getComputedStyle(deleted).backgroundColor,expectedDeletedBg:resolveBackground("color-mix(in srgb, #cf222e 12%, var(--bg-code,var(--bg-primary)))"),selectedRows:[...document.querySelectorAll('.cr-line.selected[data-line]')].map((row)=>row.dataset.side+":"+row.dataset.line),draftBody:document.querySelector("#cr-body")?.value||"",threadIds:[...document.querySelectorAll('.cr-thread[id]')].map((row)=>row.id),geometry:{added:rect(added),deleted:rect(deleted),selected:rect(selected)}}};</script><script type="module" src="/web/index.ts"></script></body></html>`;

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
    const browser = await chromium.launch({
      headless: true,
      executablePath: browserExecutable(),
      args: ["--no-sandbox"],
      env: browserEnv(),
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "light",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return { browser, page, errors };
  };

  const waitForShell = async (page: any) => {
    await page.goto(server.url.href);
    await page.waitForFunction(() => (window as any).__codeReviewReady === true);
  };

  const openReview = async (page: any, reviewId: string) => {
    await page.evaluate((path: string) => {
      const open = (window as any).__piclaw_web?.openPane;
      if (!open) throw Error("Pane bridge unavailable.");
      open({ path });
    }, PATH_PREFIX + reviewId);
    await page.waitForSelector(".cr-line.added[data-side='new'][data-line='1']");
    await page.waitForSelector(`#cr-${thread.threadId}`);
  };

  return {
    created,
    thread,
    queueCalls,
    launchPage,
    waitForShell,
    openReview,
    cleanup() {
      server.stop(true);
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function expectThemeSnapshot(snapshot: ThemeSnapshot) {
  expect(snapshot.paneBg).toBe(snapshot.expectedPaneBg);
  expect(snapshot.paneText).toBe(snapshot.expectedPaneText);
  expect(snapshot.sourceBg).toBe(snapshot.expectedSourceBg);
  expect(snapshot.sourceText).toBe(snapshot.expectedSourceText);
  expect(snapshot.threadBorder).toBe(snapshot.expectedBorder);
  expect(snapshot.accent).toBe(snapshot.expectedAccent);
  expect(snapshot.keyword).toBe(snapshot.expectedKeyword);
  expect(snapshot.fn).toBe(snapshot.expectedFn);
  expect(snapshot.string2).toBe(snapshot.expectedString2);
  expect(snapshot.addedBg).toBe(snapshot.expectedAddedBg);
  expect(snapshot.deletedBg).toBe(snapshot.expectedDeletedBg);
}

function expectLineGeometry(snapshot: ThemeSnapshot) {
  for (const row of [snapshot.geometry.added, snapshot.geometry.deleted, snapshot.geometry.selected]) {
    expect(row.width).toBeGreaterThan(100);
    expect(row.height).toBeGreaterThan(17.5);
    expect(row.height).toBeLessThan(18.5);
  }
}

test(
  "CR-143/144/145/146/147 theme tokens follow host CSS variables without remounting the review pane",
  async () => {
    const harness = await createHarness("theme-tokens");
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const launched = await harness.launchPage();
      browser = launched.browser;
      const { page, errors } = launched;

      await harness.waitForShell(page);
      await harness.openReview(page, harness.created.reviewId);

      expect(
        await page.locator('.cr-line.added[data-side="new"][data-line="1"] code').innerHTML(),
      ).toContain("tok-function");
      expect(
        await page.locator('.cr-line.added[data-side="new"][data-line="2"] code').innerHTML(),
      ).toContain("tok-string2");
      expect(
        await page.locator('.cr-line.deleted[data-side="old"][data-line="2"] code').innerHTML(),
      ).toContain("tok-string");

      await page.locator('.cr-line.added[data-side="new"][data-line="2"] > button[data-action="select-line"]').click();
      await page.waitForSelector('.cr-line.selected[data-side="new"][data-line="2"]');
      await page.locator('[data-action="range-comment"]').click();
      await page.locator('#cr-body').fill(DRAFT_BODY);
      await page.evaluate(() => {
        (window as any).__initialPane = document.querySelector(".cr-pane");
      });

      const dark = await page.evaluate(() => (window as any).__snapshotThemeState()) as ThemeSnapshot;
      expect(dark.hostTheme).toBe("dark");
      expect(dark.contextColorScheme).toBe("light");
      expect(dark.mountCount).toBe(1);
      expect(dark.samePane).toBe(true);
      expectThemeSnapshot(dark);
      expectLineGeometry(dark);
      expect(dark.success).toBe(dark.danger);
      expect(dark.addedBg).not.toBe(dark.deletedBg);
      expect(dark.selectedRows).toEqual(["new:2"]);
      expect(dark.draftBody).toBe(DRAFT_BODY);
      expect(dark.threadIds).toContain(`cr-${harness.thread.threadId}`);

      await page.emulateMedia({ colorScheme: "dark" });
      await page.evaluate(() => {
        (window as any).__applyHostTheme("light", "dark");
      });
      await page.waitForFunction(
        () => {
          const snapshot = (window as any).__snapshotThemeState?.();
          return snapshot && snapshot.hostTheme === "light" && snapshot.paneBg === snapshot.expectedPaneBg;
        },
      );

      const light = await page.evaluate(() => (window as any).__snapshotThemeState()) as ThemeSnapshot;
      expect(light.hostTheme).toBe("light");
      expect(light.contextColorScheme).toBe("dark");
      expect(light.mountCount).toBe(1);
      expect(light.samePane).toBe(true);
      expectThemeSnapshot(light);
      expectLineGeometry(light);
      expect(light.success).toBe(light.danger);
      expect(light.addedBg).not.toBe(light.deletedBg);
      expect(light.addedBg).not.toBe(dark.addedBg);
      expect(light.deletedBg).not.toBe(dark.deletedBg);
      expect(light.selectedRows).toEqual(dark.selectedRows);
      expect(light.draftBody).toBe(DRAFT_BODY);
      expect(light.threadIds).toEqual(dark.threadIds);
      expect(Math.abs(light.geometry.added.width - dark.geometry.added.width)).toBeLessThan(0.5);
      expect(Math.abs(light.geometry.added.height - dark.geometry.added.height)).toBeLessThan(0.5);
      expect(Math.abs(light.geometry.deleted.width - dark.geometry.deleted.width)).toBeLessThan(0.5);
      expect(Math.abs(light.geometry.deleted.height - dark.geometry.deleted.height)).toBeLessThan(0.5);
      expect(Math.abs(light.geometry.selected.width - dark.geometry.selected.width)).toBeLessThan(0.5);
      expect(Math.abs(light.geometry.selected.height - dark.geometry.selected.height)).toBeLessThan(0.5);
      expect(Math.abs(light.geometry.selected.top - dark.geometry.selected.top)).toBeLessThan(0.5);
      expect(harness.queueCalls).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      harness.cleanup();
    }
  },
  60_000,
);
