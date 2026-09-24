import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

import { LIMITS } from "./contracts.js";
import { ReviewService } from "./dispatch.js";
import type { LocalContext } from "./host.js";
import { escapeHtml } from "./render-source.js";
import { reviewAction } from "./runtime.js";

const PAGE_SIZE = 300;
const TOTAL_LINES = 2705;
const PAGE_TWO_START = 301;
const PAGE_TWO_END = 600;
const LAST_PAGE_START = 2701;
const LAST_PAGE_END = TOTAL_LINES;
const PAGE_TWO_SPECIAL = "\t\t<page-two data-line=301>& preserve\ttabs</page-two>";
const PAGE_TWO_LEADING = "    leading spaces survive on page two";
const LAST_PAGE_SPECIAL = "\t<last-page data-line=2705>& keep\tbytes</last-page>";
const COMMENT_BODY = "Keep the escaped page-two marker anchored to saved line 301.";
const PATH_PREFIX = "piclaw://addon/code-review/";

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

function buildLargeSource() {
  const lines: string[] = [];
  for (let line = 1; line <= TOTAL_LINES; line++) {
    if (line === PAGE_TWO_START) {
      lines.push(PAGE_TWO_SPECIAL);
      continue;
    }
    if (line === PAGE_TWO_START + 1) {
      lines.push(PAGE_TWO_LEADING);
      continue;
    }
    if (line === PAGE_TWO_START + 2) {
      lines.push("");
      continue;
    }
    if (line === TOTAL_LINES) {
      lines.push(LAST_PAGE_SPECIAL);
      continue;
    }
    lines.push(
      `const row_${String(line).padStart(4, "0")} = "payload ${String(line).padStart(4, "0")} ${"wrap_segment_".repeat(3)}<safe-${line}>";`,
    );
  }
  return lines.join("\n") + "\n";
}

function sha256Utf8(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("CR-083/089/149/151 browser pages a bounded large saved file honestly and stably", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-large-file-pane-"));
  const sourcePath = join(root, "large.ts");
  const sourceText = buildLargeSource();
  writeFileSync(sourcePath, sourceText);
  const beforeBytes = readFileSync(sourcePath);
  expect(beforeBytes.length).toBeGreaterThan(96 * 1024);
  expect(beforeBytes.length).toBeLessThan(LIMITS.fileBytes);
  expect(sourceText.split("\n").length - 1).toBe(TOTAL_LINES);
  expect(TOTAL_LINES).toBeGreaterThan(2500);
  expect(TOTAL_LINES).toBeLessThan(LIMITS.fileLines);

  const store = new ReviewService(join(root, "review.db"));
  const target = {
    chatJid: "web:worker",
    incarnation: "branch1",
    agentName: "worker",
    label: "Worker",
    active: false,
  };
  let enqueueCalls = 0;
  const ctx: LocalContext = {
    version: 1,
    accessMode: "single-user",
    ownerId: "owner",
    actorId: "human",
    kind: "operator",
    workspaceRoot: root,
    workspaceId: "workspace",
    async listTargets() {
      return [target];
    },
    async resolveTarget(input) {
      return (!input.incarnation || input.incarnation === target.incarnation) &&
          (input.chatJid === target.chatJid || input.agentName === target.agentName)
        ? target
        : null;
    },
    async enqueue() {
      enqueueCalls++;
      throw Error("Browsing a saved large file must not queue work.");
    },
  };

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const created = await reviewAction(
      ctx,
      "create",
      {
        path: "large.ts",
        target: { agentName: "worker" },
        requestId: "create-large-file-review",
      },
      store,
    ) as { reviewId: string; snapshotId: string; files: string[] };

    const initial = await reviewAction(
      ctx,
      "file",
      { reviewId: created.reviewId, fileId: created.files[0], offset: 0, limit: PAGE_SIZE },
      store,
    ) as {
      offset: number;
      limit: number;
      new: { highlighted: boolean; total: number; language: string; lines: Array<{ number: number; text: string }> };
    };
    expect(initial.offset).toBe(0);
    expect(initial.limit).toBe(PAGE_SIZE);
    expect(initial.new.highlighted).toBe(false);
    expect(initial.new.language).toBe("typescript");
    expect(initial.new.total).toBe(TOTAL_LINES);
    expect(initial.new.lines).toHaveLength(PAGE_SIZE);

    const transpile = new Bun.Transpiler({ loader: "ts", target: "browser" });
    const shell = `<!doctype html><html><head><style>:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-hover:#eee;--border-color:#ccc;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fff;--text-code:#222;--success-color:#287d42;--danger-color:#ac3131;--font-family:system-ui;--font-family-mono:monospace}html,body{height:100%;margin:0}#pane{height:calc(100% - 40px)}</style></head><body><button id="open-review">Open review</button><main id="pane"></main><script>window.__codeReviewReady=false;let pane;window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;window.__codeReviewReady=true},registerWorkspaceAction(){},openPane(ctx){window.instance=pane.mount(document.getElementById('pane'),{path:ctx.path,mode:'view'});return true}};document.getElementById('open-review').onclick=()=>window.__piclaw_web.openPane({path:'${PATH_PREFIX}${created.reviewId}'});</script><script type="module" src="/web/index.ts"></script></body></html>`;
    server = Bun.serve({
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
            return Response.json(
              {
                ok: false,
                error: { message: (error as Error).message },
              },
              { status: 400 },
            );
          }
        }
        return new Response("Not found", { status: 404 });
      },
    });

    browser = await chromium.launch({
      headless: true,
      executablePath: browserExecutable(),
      args: ["--no-sandbox"],
      env: browserEnv(),
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    const paginationText = () =>
      page.locator(".cr-pagination span").textContent();
    const rowCount = () =>
      page.locator(".cr-source .cr-line").count();
    const codeText = (line: number) =>
      page.locator(`.cr-line[data-line="${line}"] code`).textContent();
    const codeHtmlAt = (line: number) =>
      page
        .locator(`.cr-line[data-line="${line}"] code`)
        .evaluate((element) => element.innerHTML);
    const waitForRange = async (value: string) => {
      await page.waitForFunction(
        (expected) => document.querySelector(".cr-pagination span")?.textContent === expected,
        value,
      );
    };

    await page.goto(server.url.href);
    await page.waitForFunction(() => (window as any).__codeReviewReady === true);
    await page.locator("#open-review").click();
    await page.waitForSelector('.cr-line[data-line="1"]');
    await waitForRange("1–300");

    expect(await rowCount()).toBe(PAGE_SIZE);
    expect(await page.locator(".cr-file-header .cr-muted").textContent()).toContain(
      "typescript (plain)",
    );
    expect(await page.locator(".cr-source .cr-line code span").count()).toBe(0);
    expect(await page.locator('[data-action="previous"]').isDisabled()).toBe(true);
    expect(await page.locator('[data-action="next"]').isDisabled()).toBe(false);

    await page.locator('[data-action="next"]').click();
    await waitForRange("301–600");

    expect(await paginationText()).toBe("301–600");
    expect(await rowCount()).toBe(PAGE_SIZE);
    expect(await page.locator(".cr-source .cr-line").first().getAttribute("data-line")).toBe(
      String(PAGE_TWO_START),
    );
    expect(await codeText(PAGE_TWO_START)).toBe(PAGE_TWO_SPECIAL);
    expect(await codeHtmlAt(PAGE_TWO_START)).toBe(escapeHtml(PAGE_TWO_SPECIAL));
    expect(await codeText(PAGE_TWO_START + 1)).toBe(PAGE_TWO_LEADING);
    expect(await codeText(PAGE_TWO_START + 2)).toBe("");

    await page.locator(`[data-action="line-comment"][data-line="${PAGE_TWO_START}"]`).click();
    await page.waitForFunction(
      (line) => document.querySelector(".cr-selection")?.textContent?.includes(`source lines ${line}–${line}`) === true,
      PAGE_TWO_START,
    );
    await page.locator("#cr-body").fill(COMMENT_BODY);
    await page.locator('[data-action="post"]').click();
    await page.waitForFunction(
      () => document.querySelector(".cr-status")?.textContent?.includes("No agent work queued.") === true,
    );

    const threads = store.listThreads(ctx, created.reviewId);
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    const anchor = thread.anchor;
    expect(anchor.snapshotFileId).toBe(created.files[0]);
    expect(anchor.scope).toBe("range");
    expect(anchor.side).toBe("source");
    expect(anchor.startLine).toBe(PAGE_TWO_START);
    expect(anchor.endLine).toBe(PAGE_TWO_START);
    expect(anchor.selectedText).toBe(PAGE_TWO_SPECIAL);
    expect(anchor.blobSha256).toBe(sha256Utf8(sourceText));

    const stored = store.getThread(ctx, thread.id);
    expect(stored.source.fileId).toBe(created.files[0]);
    expect(stored.source.snapshotId).toBe(created.snapshotId);
    expect(stored.messages[0]?.body).toBe(COMMENT_BODY);
    expect(await rowCount()).toBe(PAGE_SIZE);
    await page.waitForSelector(`#cr-${thread.id}`);
    await page.locator(`#cr-${thread.id} [data-action="expand"]`).click();
    await page.waitForFunction(
      ({ id, body }) => document.querySelector(`#cr-${id} .cr-message-body`)?.textContent === body,
      { id: thread.id, body: COMMENT_BODY },
    );

    let guard = 0;
    while (!(await page.locator('[data-action="next"]').isDisabled())) {
      const before = await paginationText();
      await page.locator('[data-action="next"]').click();
      await page.waitForFunction(
        (expected) => document.querySelector(".cr-pagination span")?.textContent !== expected,
        before,
      );
      if (++guard > 20) throw Error("Failed to reach the last bounded page.");
    }

    expect(await paginationText()).toBe(`${LAST_PAGE_START}–${LAST_PAGE_END}`);
    expect(await rowCount()).toBe(LAST_PAGE_END - LAST_PAGE_START + 1);
    expect(await rowCount()).toBeLessThanOrEqual(PAGE_SIZE);
    expect(await page.locator(".cr-source .cr-line").first().getAttribute("data-line")).toBe(
      String(LAST_PAGE_START),
    );
    expect(await codeText(LAST_PAGE_END)).toBe(LAST_PAGE_SPECIAL);
    expect(await codeHtmlAt(LAST_PAGE_END)).toBe(escapeHtml(LAST_PAGE_SPECIAL));
    expect(await page.locator('[data-action="next"]').isDisabled()).toBe(true);

    guard = 0;
    while ((await paginationText()) !== "301–600") {
      const before = await paginationText();
      await page.locator('[data-action="previous"]').click();
      await page.waitForFunction(
        (expected) => document.querySelector(".cr-pagination span")?.textContent !== expected,
        before,
      );
      if (++guard > 20) throw Error("Failed to return to page two.");
    }

    expect(await rowCount()).toBe(PAGE_SIZE);
    expect(await codeText(PAGE_TWO_START)).toBe(PAGE_TWO_SPECIAL);
    expect(await codeHtmlAt(PAGE_TWO_START)).toBe(escapeHtml(PAGE_TWO_SPECIAL));
    expect(await page.locator(`#cr-${thread.id} .cr-message-body`).textContent()).toBe(COMMENT_BODY);
    expect(await page.locator('[data-action="previous"]').isDisabled()).toBe(false);
    expect(enqueueCalls).toBe(0);
    expect(readFileSync(sourcePath).equals(beforeBytes)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    server?.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
