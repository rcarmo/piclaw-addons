/**
 * stealth-browser — Stealth browser automation add-on for Piclaw.
 *
 * Wraps @mochi.js/core to provide a human-like browser tool that bypasses
 * anti-bot detection. Uses consistent fingerprint profiles, realistic mouse
 * trajectories, and Chrome-native TLS for network requests.
 *
 * Complements the existing cdp_browser tool which connects to user-launched
 * browsers. This tool manages its own headless Chromium lifecycle.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Lazy-loaded mochi module
// ---------------------------------------------------------------------------

let mochiModule: typeof import("@mochi.js/core") | null = null;

async function getMochi(): Promise<typeof import("@mochi.js/core")> {
  if (!mochiModule) mochiModule = await import("@mochi.js/core");
  return mochiModule;
}

// ---------------------------------------------------------------------------
// Session pool — reuse a session within an agent turn
// ---------------------------------------------------------------------------

interface ManagedSession {
  session: any;
  seed: string;
  profile: string | undefined;
  lastUsed: number;
}

let activeSession: ManagedSession | null = null;
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // close after 5 min idle

function getSessionSeed(): string {
  // Stable seed derived from env — ensures fingerprint consistency across calls.
  // Falls back to a workspace-stable default.
  return process.env.PICLAW_STEALTH_SEED
    || process.env.HOSTNAME
    || "piclaw-stealth-default-seed";
}

function getSessionProfile(): string | undefined {
  // If set, override the auto-detected profile.
  const profile = (process.env.PICLAW_STEALTH_PROFILE || "").trim();
  return profile || undefined;
}

function getProxyConfig(): string | undefined {
  const proxy = (process.env.PICLAW_STEALTH_PROXY || "").trim();
  return proxy || undefined;
}

function isHeadless(): boolean {
  const value = (process.env.PICLAW_STEALTH_HEADLESS || "true").trim().toLowerCase();
  return value !== "false" && value !== "0" && value !== "off";
}

async function ensureSession(): Promise<any> {
  if (activeSession) {
    activeSession.lastUsed = Date.now();
    return activeSession.session;
  }

  const mochi = await getMochi();
  const seed = getSessionSeed();
  const profile = getSessionProfile();
  const proxy = getProxyConfig();

  const opts: Record<string, unknown> = {
    seed,
    headlessMode: isHeadless() ? "new" : "off",
  };
  if (profile) opts.profile = profile;
  if (proxy) opts.proxy = proxy;

  const session = await mochi.launch(opts as any);
  activeSession = { session, seed, profile, lastUsed: Date.now() };

  // Auto-close on idle
  scheduleIdleClose();
  return session;
}

let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (activeSession && Date.now() - activeSession.lastUsed >= SESSION_IDLE_TIMEOUT_MS) {
      await closeSession();
    }
  }, SESSION_IDLE_TIMEOUT_MS + 1000);
}

async function closeSession(): Promise<void> {
  if (!activeSession) return;
  try {
    await activeSession.session.close();
  } catch { /* already closed */ }
  activeSession = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

// ---------------------------------------------------------------------------
// Tool actions
// ---------------------------------------------------------------------------

async function actionGoto(params: Record<string, unknown>): Promise<string> {
  const session = await ensureSession();
  const url = String(params.url || "").trim();
  if (!url) throw new Error("url is required");
  const pages = session.pages();
  const page = pages.length > 0 ? pages[0] : await session.newPage();
  await page.goto(url, { waitUntil: params.waitUntil || "load" });
  const title = await page.evaluate(() => document.title);
  return `Navigated to: ${url}\nTitle: ${title}`;
}

async function actionClick(params: Record<string, unknown>): Promise<string> {
  const session = await ensureSession();
  const selector = String(params.selector || "").trim();
  if (!selector) throw new Error("selector is required");
  const page = session.pages()[0];
  if (!page) throw new Error("No page open. Use goto first.");
  await page.humanClick(selector);
  return `Clicked: ${selector}`;
}

async function actionType(params: Record<string, unknown>): Promise<string> {
  const session = await ensureSession();
  const selector = String(params.selector || "").trim();
  const text = String(params.text || "");
  if (!selector) throw new Error("selector is required");
  if (!text) throw new Error("text is required");
  const page = session.pages()[0];
  if (!page) throw new Error("No page open. Use goto first.");
  await page.humanType(selector, text);
  return `Typed ${text.length} chars into: ${selector}`;
}

async function actionScroll(params: Record<string, unknown>): Promise<string> {
  const session = await ensureSession();
  const page = session.pages()[0];
  if (!page) throw new Error("No page open. Use goto first.");
  const to = params.to ?? "bottom";
  await page.humanScroll({ to, duration: params.duration as number | undefined });
  return `Scrolled to: ${to}`;
}

async function actionScreenshot(params: Record<string, unknown>): Promise<string> {
  const session = await ensureSession();
  const page = session.pages()[0];
  if (!page) throw new Error("No page open. Use goto first.");
  const opts: Record<string, unknown> = {};
  if (params.fullPage) opts.fullPage = true;
  if (params.format) opts.format = params.format;
  const data = await page.screenshot({ ...opts, encoding: "base64" });
  const outPath = String(params.outPath || "/workspace/tmp/stealth-screenshot.png").trim();
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(data, "base64"));
  return `Screenshot saved: ${outPath}`;
}

async function actionEvaluate(params: Record<string, unknown>): Promise<string> {
  const session = await ensureSession();
  const page = session.pages()[0];
  if (!page) throw new Error("No page open. Use goto first.");
  const expr = String(params.expr || "").trim();
  if (!expr) throw new Error("expr is required");
  // mochi evaluate takes a zero-arg function, so wrap the expression
  const result = await page.evaluate(new Function(`return (${expr})`) as () => unknown);
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

async function actionText(params: Record<string, unknown>): Promise<string> {
  const session = await ensureSession();
  const page = session.pages()[0];
  if (!page) throw new Error("No page open. Use goto first.");
  const selector = String(params.selector || "body").trim();
  const text = await page.text(selector);
  const max = 30_000;
  return text.length > max ? text.slice(0, max) + `\n[Truncated at ${max} chars]` : text;
}

async function actionFetch(params: Record<string, unknown>): Promise<string> {
  const session = await ensureSession();
  const url = String(params.url || "").trim();
  if (!url) throw new Error("url is required");
  const init: Record<string, unknown> = {};
  if (params.method) init.method = params.method;
  if (params.headers) init.headers = params.headers;
  if (params.body) init.body = params.body;
  const response = await session.fetch(url, Object.keys(init).length > 0 ? init : undefined);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("json")
    ? JSON.stringify(await response.json(), null, 2)
    : await response.text();
  const max = 30_000;
  const truncated = body.length > max ? body.slice(0, max) + `\n[Truncated]` : body;
  return `HTTP ${response.status} ${response.statusText}\nContent-Type: ${contentType}\n\n${truncated}`;
}

async function actionCookies(params: Record<string, unknown>): Promise<string> {
  const session = await ensureSession();
  if (params.save) {
    const path = String(params.save);
    await session.cookies.save(path);
    return `Cookies saved to: ${path}`;
  }
  if (params.load) {
    const path = String(params.load);
    await session.cookies.load(path);
    return `Cookies loaded from: ${path}`;
  }
  const cookies = await session.cookies.get();
  return JSON.stringify(cookies, null, 2);
}

async function actionClose(): Promise<string> {
  await closeSession();
  return "Session closed.";
}

async function actionStatus(): Promise<string> {
  if (!activeSession) return "No active stealth browser session.";
  const pages = activeSession.session.pages();
  return [
    `Session active (seed: ${activeSession.seed}, profile: ${activeSession.profile || "auto"})`,
    `Pages: ${pages.length}`,
    ...pages.map((p: any, i: number) => `  ${i + 1}. ${p.url}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const ACTIONS = ["goto", "click", "type", "scroll", "screenshot", "evaluate", "text", "fetch", "cookies", "status", "close"] as const;

export default function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "stealth_browser",
    label: "Stealth Browser",
    description:
      "Human-like browser automation with anti-detection bypass (mochi.js). " +
      "Manages its own headless Chromium with consistent fingerprints and realistic interactions. " +
      `Actions: ${ACTIONS.join(", ")}.`,
    promptSnippet:
      "Stealth browser: goto URL, humanClick/humanType/humanScroll elements, screenshot, evaluate JS, " +
      "fetch through Chrome TLS, manage cookies. Session persists across calls within a turn.",
    parameters: Type.Object({
      action: Type.String({ description: `One of: ${ACTIONS.join(", ")}` }),
      url: Type.Optional(Type.String({ description: "URL (for goto/fetch)" })),
      selector: Type.Optional(Type.String({ description: "CSS selector (for click/type/text)" })),
      text: Type.Optional(Type.String({ description: "Text to type (for type action)" })),
      expr: Type.Optional(Type.String({ description: "JS expression (for evaluate action)" })),
      to: Type.Optional(Type.String({ description: "Scroll target: 'top', 'bottom', or pixel number (for scroll)" })),
      duration: Type.Optional(Type.Number({ description: "Scroll duration in ms" })),
      outPath: Type.Optional(Type.String({ description: "Output file path (for screenshot)" })),
      fullPage: Type.Optional(Type.Boolean({ description: "Full-page screenshot" })),
      format: Type.Optional(Type.String({ description: "Screenshot format: png, jpeg, webp" })),
      method: Type.Optional(Type.String({ description: "HTTP method (for fetch)" })),
      headers: Type.Optional(Type.Unknown({ description: "HTTP headers object (for fetch)" })),
      body: Type.Optional(Type.String({ description: "HTTP body (for fetch)" })),
      save: Type.Optional(Type.String({ description: "Path to save cookies" })),
      load: Type.Optional(Type.String({ description: "Path to load cookies from" })),
      waitUntil: Type.Optional(Type.String({ description: "Navigation wait strategy: load, domcontentloaded" })),
    }),
    async execute(_id, params: any) {
      switch (params.action) {
        case "goto": return { content: [{ type: "text", text: await actionGoto(params) }] };
        case "click": return { content: [{ type: "text", text: await actionClick(params) }] };
        case "type": return { content: [{ type: "text", text: await actionType(params) }] };
        case "scroll": return { content: [{ type: "text", text: await actionScroll(params) }] };
        case "screenshot": return { content: [{ type: "text", text: await actionScreenshot(params) }] };
        case "evaluate": return { content: [{ type: "text", text: await actionEvaluate(params) }] };
        case "text": return { content: [{ type: "text", text: await actionText(params) }] };
        case "fetch": return { content: [{ type: "text", text: await actionFetch(params) }] };
        case "cookies": return { content: [{ type: "text", text: await actionCookies(params) }] };
        case "status": return { content: [{ type: "text", text: await actionStatus() }] };
        case "close": return { content: [{ type: "text", text: await actionClose() }] };
        default: throw new Error(`Unknown action: ${params.action}. Use: ${ACTIONS.join(", ")}`);
      }
    },
  });

  // Cleanup hook — close session when the extension is unloaded
  pi.registerShutdownHook?.(async () => {
    await closeSession();
  });
}
