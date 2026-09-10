import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export type MaybeAbortSignal = AbortSignal | null | undefined;
export type BrowserLaunch = { command: string; name: string };
export const CDP_PORTS = [9224, 9225, 9226, 9227, 9228, 9229, 9230, 9231, 9232, 9233] as const;
const launchedBrowsers = new Map<number, ChildProcess>();

function abortError(message = "Operation cancelled"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: MaybeAbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function bindAbort(signal: MaybeAbortSignal, onAbort: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 3000, signal?: MaybeAbortSignal): Promise<any> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const unbind = bindAbort(signal, () => controller.abort());
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`CDP HTTP ${response.status} for ${url}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
    unbind();
  }
}

async function sleep(ms: number, signal?: MaybeAbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unbind();
      resolve();
    }, ms);
    const unbind = bindAbort(signal, () => {
      clearTimeout(timer);
      reject(abortError());
    });
  });
}

function commandExists(command: string): boolean {
  try {
    return (spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true }).status ?? 1) === 0;
  } catch {
    return false;
  }
}

function browserExists(candidate: BrowserLaunch): boolean {
  const pathLike = candidate.command.includes(sep) || candidate.command.includes("/") || candidate.command.includes("\\");
  return pathLike ? existsSync(candidate.command) : commandExists(candidate.command);
}

export function findBrowser(): BrowserLaunch | null {
  const candidates: BrowserLaunch[] = [];
  if (process.platform === "win32") {
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    const local = process.env.LOCALAPPDATA ?? "";
    candidates.push(
      { command: join(pf86, "Microsoft/Edge/Application/msedge.exe"), name: "Edge" },
      { command: join(pf, "Microsoft/Edge/Application/msedge.exe"), name: "Edge" },
      { command: join(local, "Microsoft/Edge/Application/msedge.exe"), name: "Edge" },
      { command: join(pf, "Google/Chrome/Application/chrome.exe"), name: "Chrome" },
      { command: join(pf86, "Google/Chrome/Application/chrome.exe"), name: "Chrome" },
      { command: join(local, "Google/Chrome/Application/chrome.exe"), name: "Chrome" },
      { command: "msedge.exe", name: "Edge" },
      { command: "chrome.exe", name: "Chrome" },
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      { command: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", name: "Edge" },
      { command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "Chrome" },
      { command: "/Applications/Chromium.app/Contents/MacOS/Chromium", name: "Chromium" },
    );
  } else {
    candidates.push(
      { command: "/usr/bin/microsoft-edge", name: "Edge" },
      { command: "/usr/bin/google-chrome", name: "Chrome" },
      { command: "/usr/bin/chromium", name: "Chromium" },
      { command: "/snap/bin/chromium", name: "Chromium" },
      { command: "microsoft-edge", name: "Edge" },
      { command: "google-chrome", name: "Chrome" },
      { command: "chromium", name: "Chromium" },
    );
  }
  return candidates.find(browserExists) ?? null;
}

export async function findCdpPort(signal?: MaybeAbortSignal): Promise<number | null> {
  // Reuse only a browser launched by this helper. Never attach Office export to
  // an unrelated interactive/automation CDP profile owned by another workflow.
  for (const [port, child] of launchedBrowsers) {
    if (child.exitCode !== null) {
      launchedBrowsers.delete(port);
      continue;
    }
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, {}, 800, signal);
      if (version && typeof version === "object") return port;
    } catch (error) {
      if ((error as Error).name === "AbortError" && signal?.aborted) throw error;
    }
  }
  return null;
}

export async function ensureBrowser(
  signal?: MaybeAbortSignal,
  options: { ports?: readonly number[]; browser?: BrowserLaunch | null; profileRoot?: string } = {},
): Promise<number | null> {
  const existing = await findCdpPort(signal);
  if (existing) return existing;
  const browser = options.browser === undefined ? findBrowser() : options.browser;
  if (!browser) return null;

  for (const port of options.ports ?? CDP_PORTS) {
    throwIfAborted(signal);
    // Skip ports owned by other browser automation sessions.
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`, {}, 400, signal);
      continue;
    } catch (error) {
      if ((error as Error).name === "AbortError" && signal?.aborted) throw error;
    }
    const profile = join(options.profileRoot ?? tmpdir(), `piclaw-office-tools-cdp-${process.pid}-${port}`);
    mkdirSync(profile, { recursive: true });
    const child = spawn(browser.command, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-first-run",
      "--disable-default-apps",
      "--disable-features=AutomationControlled",
      "about:blank",
    ], { stdio: "ignore", windowsHide: true });
    launchedBrowsers.set(port, child);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await fetchJson(`http://127.0.0.1:${port}/json/version`, {}, 800, signal);
        return port;
      } catch (error) {
        if ((error as Error).name === "AbortError" && signal?.aborted) throw error;
        if (child.exitCode !== null) break;
        await sleep(250, signal);
      }
    }
    launchedBrowsers.delete(port);
    try { child.kill(); } catch {}
  }
  return null;
}

async function openTab(port: number, url: string, signal?: MaybeAbortSignal): Promise<any> {
  return fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }, 5000, signal);
}

async function closeTab(port: number, targetId: string): Promise<void> {
  try {
    await fetchJson(`http://127.0.0.1:${port}/json/close/${targetId}`, { method: "PUT" }, 3000);
  } catch {}
}

async function connect(webSocketDebuggerUrl: string, signal?: MaybeAbortSignal): Promise<WebSocket> {
  throwIfAborted(signal);
  return await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      unbind();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { ws.close(); } catch {}
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("CDP websocket timeout")), 5000);
    const unbind = bindAbort(signal, () => fail(abortError()));
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ws);
    }, { once: true });
    ws.addEventListener("error", () => fail(new Error("CDP websocket connection failed")), { once: true });
  });
}

let nextCommandId = 1;
async function send(ws: WebSocket, method: string, params: any, signal?: MaybeAbortSignal): Promise<any> {
  throwIfAborted(signal);
  const id = nextCommandId++;
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      unbind();
      ws.removeEventListener("message", onMessage);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`CDP command timed out: ${method}`));
    }, 15000);
    const unbind = bindAbort(signal, () => {
      cleanup();
      reject(abortError());
    });
    const onMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        cleanup();
        if (message.error) reject(new Error(`CDP ${method}: ${message.error.message ?? message.error.code}`));
        else resolve(message.result ?? null);
      } catch {}
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

export interface PrintToPdfOptions {
  port: number;
  outPath: string;
  url: string;
  waitMs?: number;
  printBackground?: boolean;
  preferCSSPageSize?: boolean;
  signal?: MaybeAbortSignal;
}

export async function printToPdf(options: PrintToPdfOptions): Promise<{ file: string; title?: string; url?: string }> {
  const target = await openTab(options.port, options.url, options.signal);
  if (!target?.id || !target?.webSocketDebuggerUrl) throw new Error("CDP did not create a printable page target");
  try {
    await sleep(options.waitMs ?? 1000, options.signal);
    const ws = await connect(target.webSocketDebuggerUrl, options.signal);
    try {
      await send(ws, "Page.enable", {}, options.signal);
      const printed = await send(ws, "Page.printToPDF", {
        printBackground: options.printBackground ?? true,
        preferCSSPageSize: options.preferCSSPageSize ?? true,
      }, options.signal);
      if (!printed?.data) throw new Error("CDP returned no PDF data");
      mkdirSync(dirname(options.outPath), { recursive: true });
      writeFileSync(options.outPath, Buffer.from(printed.data, "base64"));
      return { file: options.outPath, title: target.title, url: target.url };
    } finally {
      try { ws.close(); } catch {}
    }
  } finally {
    await closeTab(options.port, target.id);
    const launched = launchedBrowsers.get(options.port);
    if (launched) {
      launchedBrowsers.delete(options.port);
      try { launched.kill(); } catch {}
    }
  }
}
