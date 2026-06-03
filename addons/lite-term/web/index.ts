// @ts-nocheck
/**
 * lite-term/web/index.ts — xterm.js terminal pane replacement for Piclaw.
 *
 * Replaces the built-in Ghostty terminal panes by registering the same pane ids:
 * `terminal` and `terminal-tab`. The backend remains Piclaw's existing
 * /terminal/session + /terminal/ws JSON protocol.
 */

const ADDON_PACKAGE = "@rcarmo/piclaw-addon-lite-term";
const ASSET_BASE = `/agent/addons/assets/${encodeURIComponent(ADDON_PACKAGE)}`;
const TERMINAL_TAB_PATH = "piclaw://terminal";
const TERMINAL_ANON_CLIENT_HEADER = "x-piclaw-terminal-client";
const TERMINAL_ANON_CLIENT_STORAGE_KEY = "piclaw_terminal_client";
const RENDERER_STORAGE_KEY = "piclaw:lite-term:renderer";
const STYLE_ID = "piclaw-lite-term-style";
const XTERM_CSS_ID = "piclaw-lite-term-xterm-css";
const TERMINAL_FONT_FAMILY = 'FiraCode Nerd Font Mono, JetBrainsMono Nerd Font Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const TERMINAL_HEARTBEAT_MS = 25_000;
const TERMINAL_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000];

const LIGHT_TERMINAL_PALETTE = {
  yellow: "#9a6700",
  magenta: "#8250df",
  cyan: "#1b7c83",
  brightBlack: "#57606a",
  brightRed: "#cf222e",
  brightGreen: "#1a7f37",
  brightYellow: "#bf8700",
  brightBlue: "#0550ae",
  brightMagenta: "#6f42c1",
  brightCyan: "#0a7b83",
};

const DARK_TERMINAL_PALETTE = {
  yellow: "#d29922",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  brightBlack: "#8b949e",
  brightRed: "#ff7b72",
  brightGreen: "#7ee787",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
};

let xtermRuntimePromise = null;
let fontsReadyPromise = null;
let paneRegistered = false;

function asset(path) {
  return `${ASSET_BASE}/${path.replace(/^\/+/, "")}`;
}

function injectStyles(ownerDocument = document) {
  if (!ownerDocument?.head) return;
  if (!ownerDocument.getElementById(XTERM_CSS_ID)) {
    const link = ownerDocument.createElement("link");
    link.id = XTERM_CSS_ID;
    link.rel = "stylesheet";
    link.href = asset("web/vendor/xterm.css");
    ownerDocument.head.appendChild(link);
  }
  if (!ownerDocument.getElementById(STYLE_ID)) {
    const style = ownerDocument.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .lite-terminal-pane {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        width: 100%;
        height: 100%;
        position: relative;
        overflow: hidden;
        background: var(--bg-primary, #0d1117);
        color: var(--text-primary, #e6edf3);
        font-family: var(--font-family-terminal, ${TERMINAL_FONT_FAMILY});
      }
      .lite-terminal-pane .lite-terminal-body {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        padding: 6px;
        box-sizing: border-box;
      }
      .lite-terminal-pane .lite-terminal-host {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
        width: 100%;
        height: 100%;
      }
      .lite-terminal-pane .xterm {
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
        width: 100%;
        height: 100%;
        padding: 0;
      }
      .lite-terminal-pane .xterm-viewport,
      .lite-terminal-pane .xterm-screen {
        background: transparent !important;
      }
      .lite-terminal-pane .xterm-viewport {
        scrollbar-width: none;
      }
      .lite-terminal-pane .xterm-viewport::-webkit-scrollbar {
        width: 0;
        height: 0;
      }
      .lite-terminal-scrollbar-thumb {
        position: absolute;
        right: 2px;
        top: 8px;
        width: 2px;
        min-height: 18px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--text-secondary, #8b949e) 58%, transparent);
        opacity: 0;
        pointer-events: none;
        transition: opacity .14s ease;
        z-index: 16;
      }
      .lite-terminal-pane[data-scrollbar-visible="true"] .lite-terminal-scrollbar-thumb,
      .lite-terminal-pane:focus-within .lite-terminal-scrollbar-thumb {
        opacity: .82;
      }
      .lite-terminal-pane .lite-terminal-status {
        position: absolute;
        top: 8px;
        right: 10px;
        z-index: 20;
        padding: 3px 7px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--bg-secondary, #161b22) 88%, transparent);
        border: 1px solid var(--border-color, rgba(148,163,184,.24));
        color: var(--text-secondary, #8b949e);
        font: 11px/1.3 var(--font-family-ui, system-ui, sans-serif);
        pointer-events: none;
        opacity: .82;
      }
      .lite-terminal-pane[data-connection-status="Connected"] .lite-terminal-status,
      .lite-terminal-pane[data-connection-status="Connected"] .lite-terminal-status {
        opacity: 0;
        transition: opacity .4s ease 1.4s;
      }
      .lite-terminal-pane:focus-within .lite-terminal-status {
        opacity: .82;
        transition-delay: 0s;
      }
      .lite-terminal-placeholder {
        margin: auto;
        color: var(--text-secondary, #8b949e);
        font: 13px/1.5 var(--font-family-ui, system-ui, sans-serif);
        text-align: center;
      }
    `;
    ownerDocument.head.appendChild(style);
  }
}

function detectDarkTheme(runtimeWindow = window, runtimeDocument = document) {
  const root = runtimeDocument?.documentElement;
  const body = runtimeDocument?.body;
  const rootTheme = root?.getAttribute?.("data-theme")?.toLowerCase?.() || "";
  if (rootTheme === "dark") return true;
  if (rootTheme === "light") return false;
  if (root?.classList?.contains("dark") || body?.classList?.contains("dark")) return true;
  if (root?.classList?.contains("light") || body?.classList?.contains("light")) return false;
  return Boolean(runtimeWindow?.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
}

function readThemeVar(name, fallback = "", runtimeDocument = document) {
  const value = getComputedStyle(runtimeDocument.documentElement).getPropertyValue(name)?.trim();
  return value || fallback;
}

function parseThemeColor(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  if (/^[0-9a-fA-F]{3}$/.test(hex) || /^[0-9a-fA-F]{6}$/.test(hex)) {
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    const int = parseInt(full, 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
  }
  const rgbMatch = raw.match(/rgba?\(\s*(\d+)[,\s]\s*(\d+)[,\s]\s*(\d+)/i);
  if (rgbMatch) return { r: parseInt(rgbMatch[1], 10), g: parseInt(rgbMatch[2], 10), b: parseInt(rgbMatch[3], 10) };
  return null;
}

function relativeLuminance(color) {
  const toLinear = (value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

function contrastRatio(a, b) {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function toHexColor(color) {
  const clamp = (value) => Math.max(0, Math.min(255, Math.round(value || 0)));
  return `#${[color.r, color.g, color.b].map((value) => clamp(value).toString(16).padStart(2, "0")).join("")}`;
}

function getHighestContrastTextColor(background) {
  const bg = parseThemeColor(background);
  if (!bg) return "#ffffff";
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  return contrastRatio(bg, white) >= contrastRatio(bg, black) ? "#ffffff" : "#000000";
}

function mixThemeColors(base, target, amount) {
  const ratio = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
  return {
    r: base.r + ((target.r - base.r) * ratio),
    g: base.g + ((target.g - base.g) * ratio),
    b: base.b + ((target.b - base.b) * ratio),
  };
}

function ensureTerminalColorContrast(background, color, minimumRatio = 4.5) {
  const bg = parseThemeColor(background);
  const fg = parseThemeColor(color);
  if (!bg || !fg) return color;
  if (contrastRatio(bg, fg) >= minimumRatio) return toHexColor(fg);
  const targetColor = parseThemeColor(getHighestContrastTextColor(background));
  if (!targetColor) return toHexColor(fg);
  let best = targetColor;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 14; index += 1) {
    const mid = (low + high) / 2;
    const mixed = mixThemeColors(fg, targetColor, mid);
    if (contrastRatio(bg, mixed) >= minimumRatio) {
      best = mixed;
      high = mid;
    } else {
      low = mid;
    }
  }
  return toHexColor(best);
}

function withAlpha(hexColor, alphaHex) {
  if (!hexColor || !hexColor.startsWith("#")) return hexColor;
  const value = hexColor.slice(1);
  if (value.length === 3) return `#${value[0]}${value[0]}${value[1]}${value[1]}${value[2]}${value[2]}${alphaHex}`;
  if (value.length === 6) return `#${value}${alphaHex}`;
  return hexColor;
}

export function buildLiteTermTheme(runtimeWindow = window, runtimeDocument = document) {
  const isDark = detectDarkTheme(runtimeWindow, runtimeDocument);
  const palette = isDark ? DARK_TERMINAL_PALETTE : LIGHT_TERMINAL_PALETTE;
  const background = readThemeVar("--bg-primary", isDark ? "#000000" : "#ffffff", runtimeDocument);
  const themeTextPrimary = readThemeVar("--text-primary", isDark ? "#e7e9ea" : "#0f1419", runtimeDocument);
  const foreground = ensureTerminalColorContrast(background, themeTextPrimary || getHighestContrastTextColor(background), 7);
  const accent = readThemeVar("--accent-color", "#1d9bf0", runtimeDocument);
  const danger = readThemeVar("--danger-color", isDark ? "#ff7b72" : "#cf222e", runtimeDocument);
  const success = readThemeVar("--success-color", isDark ? "#7ee787" : "#1a7f37", runtimeDocument);
  const hover = readThemeVar("--bg-hover", isDark ? "#1d1f23" : "#e8ebed", runtimeDocument);
  const selectionBackground = readThemeVar("--accent-soft-strong", withAlpha(accent, isDark ? "47" : "33"), runtimeDocument);

  return {
    background,
    foreground,
    cursor: ensureTerminalColorContrast(background, accent, 3),
    cursorAccent: background,
    selectionBackground,
    selectionForeground: foreground,
    black: ensureTerminalColorContrast(background, hover, 3),
    red: ensureTerminalColorContrast(background, danger, 4.5),
    green: ensureTerminalColorContrast(background, success, 4.5),
    yellow: ensureTerminalColorContrast(background, palette.yellow, 4.5),
    blue: ensureTerminalColorContrast(background, accent, 4.5),
    magenta: ensureTerminalColorContrast(background, palette.magenta, 4.5),
    cyan: ensureTerminalColorContrast(background, palette.cyan, 4.5),
    white: foreground,
    brightBlack: ensureTerminalColorContrast(background, palette.brightBlack, 3),
    brightRed: ensureTerminalColorContrast(background, palette.brightRed, 4.5),
    brightGreen: ensureTerminalColorContrast(background, palette.brightGreen, 4.5),
    brightYellow: ensureTerminalColorContrast(background, palette.brightYellow, 4.5),
    brightBlue: ensureTerminalColorContrast(background, palette.brightBlue, 4.5),
    brightMagenta: ensureTerminalColorContrast(background, palette.brightMagenta, 4.5),
    brightCyan: ensureTerminalColorContrast(background, palette.brightCyan, 4.5),
    brightWhite: foreground,
  };
}

export function buildLiteTermWebSocketUrl(path, handoffToken = null, clientToken = null, runtimeWindow = window) {
  const protocol = runtimeWindow.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${runtimeWindow.location.host}${path || "/terminal/ws"}`);
  if (handoffToken) url.searchParams.set("handoff", String(handoffToken));
  if (clientToken) url.searchParams.set("client", String(clientToken));
  return url.toString();
}

function createTerminalClientToken(runtimeWindow = window) {
  try {
    if (typeof runtimeWindow?.crypto?.randomUUID === "function") return runtimeWindow.crypto.randomUUID();
  } catch {}
  return `terminal-client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getOrCreateAnonymousTerminalClientToken(runtimeWindow = window) {
  if (!runtimeWindow) return null;
  try {
    const storage = runtimeWindow.localStorage;
    const existing = typeof storage?.getItem === "function" ? String(storage.getItem(TERMINAL_ANON_CLIENT_STORAGE_KEY) || "").trim() : "";
    if (existing) return existing;
    const created = createTerminalClientToken(runtimeWindow);
    storage?.setItem?.(TERMINAL_ANON_CLIENT_STORAGE_KEY, created);
    return created;
  } catch {
    return createTerminalClientToken(runtimeWindow);
  }
}

async function fetchTerminalSession(clientToken = getOrCreateAnonymousTerminalClientToken()) {
  const response = await fetch("/terminal/session", {
    method: "GET",
    credentials: "same-origin",
    headers: clientToken ? { [TERMINAL_ANON_CLIENT_HEADER]: clientToken } : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

async function requestTerminalHandoff(clientToken = getOrCreateAnonymousTerminalClientToken()) {
  const response = await fetch("/terminal/handoff", {
    method: "POST",
    credentials: "same-origin",
    headers: clientToken ? { [TERMINAL_ANON_CLIENT_HEADER]: clientToken } : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return typeof body?.handoff?.token === "string" && body.handoff.token.trim() ? body.handoff.token.trim() : null;
}

async function ensureFontsReady(ownerDocument = document) {
  if (!ownerDocument || !("fonts" in ownerDocument) || !ownerDocument.fonts) return;
  if (!fontsReadyPromise) {
    fontsReadyPromise = Promise.allSettled([
      ownerDocument.fonts.load('400 13px "FiraCode Nerd Font Mono"'),
      ownerDocument.fonts.load('700 13px "FiraCode Nerd Font Mono"'),
      ownerDocument.fonts.ready,
    ]).then(() => undefined).catch(() => undefined);
  }
  await fontsReadyPromise;
}

async function importAddon(name) {
  return import(asset(`web/vendor/addon-${name}.mjs`));
}

async function importCanvasAddon() {
  await import(asset("web/vendor/addon-canvas.js"));
  return globalThis.CanvasAddon || globalThis.canvasAddon || null;
}

async function loadXtermRuntime() {
  if (xtermRuntimePromise) return xtermRuntimePromise;
  xtermRuntimePromise = (async () => {
    const [xterm, fit, ligatures, webgl, clipboard, image, search, serialize, unicode11, webLinks, progress, unicodeGraphemes, attach] = await Promise.all([
      import(asset("web/vendor/xterm.mjs")),
      importAddon("fit"),
      importAddon("ligatures"),
      importAddon("webgl"),
      importAddon("clipboard"),
      importAddon("image"),
      importAddon("search"),
      importAddon("serialize"),
      importAddon("unicode11"),
      importAddon("web-links"),
      importAddon("progress"),
      importAddon("unicode-graphemes"),
      importAddon("attach"),
    ]);
    const canvas = await importCanvasAddon().catch(() => null);
    return { xterm, fit, ligatures, webgl, canvas, clipboard, image, search, serialize, unicode11, webLinks, progress, unicodeGraphemes, attach };
  })().catch((error) => {
    xtermRuntimePromise = null;
    throw error;
  });
  return xtermRuntimePromise;
}

function getTerminalFontFamily(runtimeDocument = document) {
  try {
    const token = getComputedStyle(runtimeDocument.documentElement).getPropertyValue("--font-family-terminal")?.trim();
    return token || TERMINAL_FONT_FAMILY;
  } catch {
    return TERMINAL_FONT_FAMILY;
  }
}

function normalizeShortcutCode(event) {
  const code = String(event?.code || "").trim().toLowerCase();
  if (code) return code;
  const key = String(event?.key || "").trim().toLowerCase();
  if (key.length === 1 && /[a-z]/.test(key)) return `key${key}`;
  return key;
}

function isCopyShortcut(event) {
  return Boolean(event?.shiftKey && !event?.altKey && (event?.ctrlKey || event?.metaKey) && normalizeShortcutCode(event) === "keyc");
}

function isPasteShortcut(event) {
  if (event?.shiftKey && !event?.ctrlKey && !event?.metaKey && !event?.altKey && normalizeShortcutCode(event) === "insert") return true;
  return Boolean(event?.shiftKey && !event?.altKey && (event?.ctrlKey || event?.metaKey) && normalizeShortcutCode(event) === "keyv");
}

function isFindShortcut(event) {
  return Boolean(event?.shiftKey && !event?.altKey && (event?.ctrlKey || event?.metaKey) && normalizeShortcutCode(event) === "keyf");
}

function getPreferredRenderer(runtimeWindow = window) {
  try {
    const value = String(runtimeWindow.localStorage?.getItem(RENDERER_STORAGE_KEY) || "").trim().toLowerCase();
    if (value === "webgl") return "webgl";
  } catch {}
  return "canvas";
}

class LiteTermPaneInstance {
  constructor(container, context = {}) {
    this.container = container;
    this.context = context;
    this.ownerDocument = container.ownerDocument || document;
    this.ownerWindow = this.ownerDocument.defaultView || window;
    this.disposed = false;
    this.resizeFrame = 0;
    this.resizeObserver = null;
    this.themeObserver = null;
    this.themeChangeListener = null;
    this.mediaQuery = null;
    this.mediaQueryListener = null;
    this.resizeListener = null;
    this.scrollbarThumb = null;
    this.scrollbarViewport = null;
    this.scrollbarScrollListener = null;
    this.scrollbarFrame = 0;
    this.scrollDisposable = null;
    this.socket = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.manualSocketClose = false;
    this.terminalExited = false;
    this.inputDisposable = null;
    this.resizeDisposable = null;
    this.terminal = null;
    this.fitAddon = null;
    this.searchAddon = null;
    this.serializeAddon = null;
    this.rendererAddon = null;
    this.loadedAddons = [];
    this.pendingHandoffToken = typeof context?.transferState?.handoffToken === "string" && context.transferState.handoffToken.trim()
      ? context.transferState.handoffToken.trim()
      : null;
    this.standbyHandoffToken = null;
    this.standbyHandoffRequest = null;

    injectStyles(this.ownerDocument);

    this.root = this.ownerDocument.createElement("div");
    this.root.className = "lite-terminal-pane";
    this.root.tabIndex = 0;
    this.body = this.ownerDocument.createElement("div");
    this.body.className = "lite-terminal-body";
    this.body.innerHTML = '<div class="lite-terminal-placeholder">Bootstrapping xterm.js…</div>';
    this.scrollbarThumb = this.ownerDocument.createElement("div");
    this.scrollbarThumb.className = "lite-terminal-scrollbar-thumb";
    this.status = this.ownerDocument.createElement("span");
    this.status.className = "lite-terminal-status";
    this.status.textContent = "Loading…";
    this.root.append(this.body, this.scrollbarThumb, this.status);
    container.appendChild(this.root);

    void this.bootstrap();
  }

  setStatus(message) {
    this.status.textContent = message;
    this.root.dataset.connectionStatus = message;
    this.root.setAttribute("aria-label", `Lite terminal ${message}`);
  }

  async bootstrap() {
    try {
      const runtime = await loadXtermRuntime();
      await ensureFontsReady(this.ownerDocument);
      if (this.disposed) return;

      const { Terminal } = runtime.xterm;
      const terminal = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: "block",
        drawBoldTextInBrightColors: true,
        fontFamily: getTerminalFontFamily(this.ownerDocument),
        fontSize: 13,
        lineHeight: 1.12,
        scrollback: 10_000,
        tabStopWidth: 8,
        theme: buildLiteTermTheme(this.ownerWindow, this.ownerDocument),
        windowsMode: false,
      });

      this.terminal = terminal;
      this.installPreOpenAddons(runtime);

      this.body.innerHTML = "";
      this.host = this.ownerDocument.createElement("div");
      this.host.className = "lite-terminal-host";
      this.body.appendChild(this.host);
      terminal.open(this.host);
      this.installPostOpenAddons(runtime);
      this.installOverlayScrollbar();
      this.installClipboardAndSearchShortcuts();
      this.installResizeSync();
      this.installThemeSync();
      this.scheduleResize(true);
      this.queueResizeRetries();

      await this.connectBackend();
    } catch (error) {
      console.error("[lite-term] failed to bootstrap xterm.js", error);
      if (!this.disposed) {
        this.body.innerHTML = `<div class="lite-terminal-placeholder">Lite Term failed to load: ${String(error?.message || error)}</div>`;
        this.setStatus("Load failed");
      }
    }
  }

  loadAddon(addon, name) {
    if (!addon || !this.terminal) return null;
    try {
      this.terminal.loadAddon(addon);
      this.loadedAddons.push(name);
      return addon;
    } catch (error) {
      console.warn(`[lite-term] failed to load xterm addon ${name}`, error);
      return null;
    }
  }

  installPreOpenAddons(runtime) {
    const terminal = this.terminal;
    if (!terminal) return;

    this.fitAddon = this.loadAddon(new runtime.fit.FitAddon(), "fit");

    this.loadAddon(new runtime.unicode11.Unicode11Addon(), "unicode11");
    this.loadAddon(new runtime.unicodeGraphemes.UnicodeGraphemesAddon(), "unicode-graphemes");
    try {
      terminal.unicode.activeVersion = "15-graphemes";
    } catch {
      try { terminal.unicode.activeVersion = "11"; } catch {}
    }

    this.loadAddon(new runtime.webLinks.WebLinksAddon(), "web-links");
    this.searchAddon = this.loadAddon(new runtime.search.SearchAddon(), "search");
    this.serializeAddon = this.loadAddon(new runtime.serialize.SerializeAddon(), "serialize");
    this.loadAddon(new runtime.progress.ProgressAddon(), "progress");

    try {
      const provider = typeof runtime.clipboard.BrowserClipboardProvider === "function"
        ? new runtime.clipboard.BrowserClipboardProvider()
        : undefined;
      this.loadAddon(new runtime.clipboard.ClipboardAddon(undefined, provider), "clipboard");
    } catch (error) {
      console.warn("[lite-term] clipboard addon unavailable", error);
    }

    try {
      this.loadAddon(new runtime.image.ImageAddon({ enableSizeReports: true, pixelLimit: 16_777_216, storageLimit: 10 }), "image");
    } catch (error) {
      console.warn("[lite-term] image addon unavailable", error);
    }

    // AttachAddon is intentionally not activated: Piclaw's terminal socket uses
    // JSON control frames rather than a raw PTY byte stream. Keep it vendored and
    // import-validated with the rest of the xterm family.
    this.attachAddonModule = runtime.attach;
  }

  installPostOpenAddons(runtime) {
    this.loadAddon(new runtime.ligatures.LigaturesAddon(), "ligatures");
    // Renderer add-ons should be activated after ligatures so the renderer can
    // pick up font-feature settings and the already-open terminal dimensions.
    this.installRendererAddon(runtime);
  }

  installRendererAddon(runtime) {
    const preferred = getPreferredRenderer(this.ownerWindow);
    if (preferred === "webgl") {
      try {
        const addon = new runtime.webgl.WebglAddon(false);
        addon.onContextLoss?.(() => {
          console.warn("[lite-term] WebGL context lost; disposing renderer addon.");
          try { addon.dispose(); } catch {}
        });
        this.rendererAddon = this.loadAddon(addon, "webgl");
        if (this.rendererAddon) return;
      } catch (error) {
        console.warn("[lite-term] webgl renderer unavailable; falling back to canvas", error);
      }
    }

    const CanvasAddon = runtime.canvas?.CanvasAddon || runtime.canvas?.default?.CanvasAddon || null;
    if (typeof CanvasAddon === "function") {
      try {
        this.rendererAddon = this.loadAddon(new CanvasAddon(), "canvas");
        if (this.rendererAddon) return;
      } catch (error) {
        console.warn("[lite-term] canvas renderer unavailable; using xterm default renderer", error);
      }
    }
  }

  installClipboardAndSearchShortcuts() {
    const terminal = this.terminal;
    if (!terminal?.attachCustomKeyEventHandler) return;
    terminal.attachCustomKeyEventHandler((event) => {
      if (isCopyShortcut(event)) {
        try {
          const selected = typeof terminal.getSelection === "function" ? String(terminal.getSelection() || "") : "";
          if (selected) void this.ownerWindow.navigator?.clipboard?.writeText?.(selected);
        } catch (error) {
          console.debug("[lite-term] copy shortcut failed", error);
        }
        return true;
      }
      if (isPasteShortcut(event)) {
        if (typeof this.ownerWindow.navigator?.clipboard?.readText === "function") {
          void this.ownerWindow.navigator.clipboard.readText().then((text) => {
            if (!this.disposed && text) terminal.paste?.(text);
          }).catch((error) => console.debug("[lite-term] paste shortcut failed", error));
          return true;
        }
      }
      if (isFindShortcut(event)) {
        const query = this.ownerWindow.prompt?.("Find in terminal buffer", "");
        if (query) this.searchAddon?.findNext?.(query);
        return true;
      }
      return undefined;
    });
  }

  applyTheme() {
    if (!this.terminal) return;
    const theme = buildLiteTermTheme(this.ownerWindow, this.ownerDocument);
    this.terminal.options.theme = theme;
    this.root.style.backgroundColor = theme.background;
    this.root.style.color = theme.foreground;
    try { this.terminal.refresh?.(0, this.terminal.rows - 1); } catch {}
    this.scheduleResize(true);
  }

  installThemeSync() {
    const sync = () => this.ownerWindow.requestAnimationFrame(() => this.applyTheme());
    this.themeChangeListener = sync;
    this.ownerWindow.addEventListener("piclaw-theme-change", sync);
    this.mediaQuery = this.ownerWindow.matchMedia?.("(prefers-color-scheme: dark)");
    this.mediaQueryListener = sync;
    if (this.mediaQuery?.addEventListener) this.mediaQuery.addEventListener("change", sync);
    else if (this.mediaQuery?.addListener) this.mediaQuery.addListener(sync);
    this.themeObserver = typeof MutationObserver !== "undefined" ? new MutationObserver(sync) : null;
    this.themeObserver?.observe(this.ownerDocument.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    if (this.ownerDocument.body) this.themeObserver?.observe(this.ownerDocument.body, { attributes: true, attributeFilter: ["class", "data-theme"] });
    sync();
  }

  installOverlayScrollbar() {
    const viewport = this.host?.querySelector?.(".xterm-viewport") || null;
    if (!viewport || !this.scrollbarThumb) return;
    if (this.scrollbarViewport && this.scrollbarViewport !== viewport && this.scrollbarScrollListener) {
      try { this.scrollbarViewport.removeEventListener("scroll", this.scrollbarScrollListener); } catch {}
    }
    this.scrollbarViewport = viewport;
    if (!this.scrollbarScrollListener) this.scrollbarScrollListener = () => this.scheduleScrollbarSync();
    viewport.addEventListener("scroll", this.scrollbarScrollListener, { passive: true });
    this.scrollDisposable = this.terminal?.onScroll?.(() => this.scheduleScrollbarSync()) || this.scrollDisposable;
    this.scheduleScrollbarSync();
  }

  scheduleScrollbarSync() {
    if (this.disposed) return;
    if (this.scrollbarFrame) this.ownerWindow.cancelAnimationFrame(this.scrollbarFrame);
    this.scrollbarFrame = this.ownerWindow.requestAnimationFrame(() => {
      this.scrollbarFrame = 0;
      this.syncOverlayScrollbar();
    });
  }

  syncOverlayScrollbar() {
    const viewport = this.scrollbarViewport || this.host?.querySelector?.(".xterm-viewport") || null;
    const thumb = this.scrollbarThumb;
    if (!viewport || !thumb || !this.root) return;
    const scrollHeight = viewport.scrollHeight || 0;
    const clientHeight = viewport.clientHeight || 0;
    const scrollable = scrollHeight > clientHeight + 1;
    this.root.dataset.scrollbarVisible = scrollable ? "true" : "false";
    if (!scrollable) return;
    const rootRect = this.root.getBoundingClientRect?.() || { top: 0, height: clientHeight };
    const viewportRect = viewport.getBoundingClientRect?.() || { top: rootRect.top, height: clientHeight };
    const trackTop = Math.max(6, Math.round((viewportRect.top || 0) - (rootRect.top || 0)));
    const trackHeight = Math.max(18, Math.round(Math.min(viewportRect.height || clientHeight, (rootRect.height || clientHeight) - trackTop - 6)));
    const thumbHeight = Math.max(18, Math.round(trackHeight * (clientHeight / scrollHeight)));
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const scrollRatio = (viewport.scrollTop || 0) / Math.max(1, scrollHeight - clientHeight);
    thumb.style.top = `${trackTop + Math.round(maxThumbTop * scrollRatio)}px`;
    thumb.style.height = `${thumbHeight}px`;
  }

  installResizeSync() {
    this.resizeListener = () => this.scheduleResize();
    this.ownerWindow.addEventListener("resize", this.resizeListener);
    this.ownerWindow.addEventListener("dock-resize", this.resizeListener);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
      this.resizeObserver.observe(this.container);
      this.resizeObserver.observe(this.root);
      this.resizeObserver.observe(this.body);
    }
  }

  scheduleResize(force = false) {
    if (this.disposed) return;
    if (this.resizeFrame) this.ownerWindow.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = this.ownerWindow.requestAnimationFrame(() => {
      this.resizeFrame = 0;
      this.resize(force);
    });
  }

  queueResizeRetries(delays = [24, 72, 160, 320, 640]) {
    for (const delay of delays) {
      this.ownerWindow.setTimeout(() => {
        if (!this.disposed) this.scheduleResize(true);
      }, delay);
    }
  }

  resize(_force = false) {
    if (!this.terminal) return;
    try { this.fitAddon?.fit?.(); } catch (error) { console.debug("[lite-term] fit failed", error); }
    this.scheduleScrollbarSync();
    this.sendResize();
  }

  sendResize() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.terminal) return;
    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    if (cols > 0 && rows > 0) this.socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  async ensureStandbyHandoffToken(force = false) {
    if (this.disposed) return null;
    if (!force && this.standbyHandoffToken) return this.standbyHandoffToken;
    if (this.standbyHandoffRequest) return await this.standbyHandoffRequest;
    this.standbyHandoffRequest = requestTerminalHandoff()
      .then((token) => {
        if (token && !this.disposed) this.standbyHandoffToken = token;
        return token || null;
      })
      .catch((error) => {
        console.warn("[lite-term] failed to prepare handoff token", error);
        return null;
      })
      .finally(() => { this.standbyHandoffRequest = null; });
    return await this.standbyHandoffRequest;
  }

  consumeStandbyHandoffToken() {
    const token = this.standbyHandoffToken || null;
    this.standbyHandoffToken = null;
    return token;
  }

  installTerminalSocketBridge() {
    const terminal = this.terminal;
    if (!terminal || this.inputDisposable || this.resizeDisposable) return;
    this.inputDisposable = terminal.onData((data) => {
      const socket = this.socket;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    });
    this.resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const socket = this.socket;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
    });
  }

  clearHeartbeat() {
    if (!this.heartbeatTimer) return;
    this.ownerWindow.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatTimer = this.ownerWindow.setInterval(() => {
      if (this.disposed || this.terminalExited) return;
      const socket = this.socket;
      if (socket?.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      } catch (error) {
        console.debug("[lite-term] heartbeat send failed", error);
      }
    }, TERMINAL_HEARTBEAT_MS);
  }

  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    this.ownerWindow.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  scheduleReconnect(reason = "socket close") {
    if (this.disposed || this.terminalExited) return;
    this.clearHeartbeat();
    this.clearReconnectTimer();
    const index = Math.min(this.reconnectAttempt, TERMINAL_RECONNECT_DELAYS_MS.length - 1);
    const delay = TERMINAL_RECONNECT_DELAYS_MS[index];
    this.reconnectAttempt += 1;
    this.setStatus(`Reconnecting…`);
    this.reconnectTimer = this.ownerWindow.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || this.terminalExited) return;
      console.info("[lite-term] reconnecting terminal websocket", { reason, attempt: this.reconnectAttempt });
      void this.connectBackend({ reconnect: true });
    }, delay);
  }

  async connectBackend(options = {}) {
    const terminal = this.terminal;
    if (!terminal) return;
    this.installTerminalSocketBridge();
    try {
      const clientToken = getOrCreateAnonymousTerminalClientToken(this.ownerWindow);
      const session = await fetchTerminalSession(clientToken);
      if (this.disposed) return;
      if (!session?.enabled) {
        terminal.write(`Terminal backend unavailable: ${session?.error || "disabled"}\r\n`);
        this.setStatus("Unavailable");
        return;
      }

      const handoffToken = this.pendingHandoffToken || null;
      const socket = new WebSocket(buildLiteTermWebSocketUrl(session.ws_path || "/terminal/ws", handoffToken, clientToken, this.ownerWindow));
      this.socket = socket;
      this.manualSocketClose = false;
      this.setStatus(handoffToken ? "Transferring…" : options.reconnect ? "Reconnecting…" : "Connecting…");

      socket.addEventListener("open", () => {
        if (this.disposed) return;
        this.reconnectAttempt = 0;
        this.clearReconnectTimer();
        this.startHeartbeat();
        if (handoffToken && this.pendingHandoffToken === handoffToken) this.pendingHandoffToken = null;
        void this.ensureStandbyHandoffToken(false);
        this.setStatus("Connected");
        terminal.focus();
        this.scheduleResize(true);
        this.queueResizeRetries([24, 72, 160, 320]);
      });

      socket.addEventListener("message", (event) => this.handleSocketMessage(event));
      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.clearHeartbeat();
        if (this.disposed || this.manualSocketClose || this.terminalExited) return;
        console.warn("[lite-term] terminal websocket closed; scheduling reconnect", { code: event.code, reason: event.reason });
        this.scheduleReconnect(event.reason || `close ${event.code}`);
      });
      socket.addEventListener("error", () => {
        if (this.disposed || this.terminalExited) return;
        this.setStatus("Connection error");
      });
    } catch (error) {
      if (options.reconnect) {
        console.warn("[lite-term] reconnect failed", error);
        this.scheduleReconnect(error instanceof Error ? error.message : String(error));
        return;
      }
      terminal.write(`Terminal backend unavailable: ${error instanceof Error ? error.message : String(error)}\r\n`);
      this.setStatus("Unavailable");
    }
  }

  handleSocketMessage(event) {
    if (this.disposed || !this.terminal) return;
    let payload;
    try { payload = JSON.parse(String(event.data)); }
    catch { payload = { type: "output", data: String(event.data) }; }

    if (payload?.type === "session") {
      this.terminal.__piclawSessionMeta = {
        sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
        createdAt: typeof payload.created_at === "string" ? payload.created_at : null,
        processPid: typeof payload.process_pid === "number" ? payload.process_pid : null,
      };
      void this.ensureStandbyHandoffToken(false);
      return;
    }
    if (payload?.type === "output" && typeof payload.data === "string") {
      this.terminal.write(payload.data, () => this.scheduleScrollbarSync());
      return;
    }
    if (payload?.type === "exit") {
      this.terminalExited = true;
      this.clearHeartbeat();
      this.clearReconnectTimer();
      this.terminal.write("\r\n[terminal exited]\r\n");
      this.setStatus("Exited");
    }
  }

  beforeDetachFromHost() {
    this.setStatus("Moving…");
  }

  afterAttachToHost(context = {}) {
    const token = typeof context?.transferState?.handoffToken === "string" && context.transferState.handoffToken.trim()
      ? context.transferState.handoffToken.trim()
      : null;
    if (token) this.pendingHandoffToken = token;
    this.scheduleResize(true);
    this.queueResizeRetries();
    this.ownerWindow.requestAnimationFrame(() => this.focus());
  }

  moveHost(_container) {
    return false;
  }

  exportHostTransferState() {
    const handoffToken = this.standbyHandoffToken || this.pendingHandoffToken || null;
    return handoffToken ? { kind: "terminal", live: false, handoffToken } : null;
  }

  async preparePopoutTransfer() {
    let handoffToken = this.consumeStandbyHandoffToken();
    if (!handoffToken) {
      await this.ensureStandbyHandoffToken(true);
      handoffToken = this.consumeStandbyHandoffToken();
    }
    if (!handoffToken) return null;
    this.pendingHandoffToken = handoffToken;
    return { terminal_handoff: handoffToken };
  }

  getContent() {
    try { return this.serializeAddon?.serialize?.(); } catch { return undefined; }
  }

  isDirty() { return false; }

  focus() {
    try { this.terminal?.focus?.(); } catch { this.root?.focus?.(); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resizeFrame) this.ownerWindow.cancelAnimationFrame(this.resizeFrame);
    this.manualSocketClose = true;
    this.clearHeartbeat();
    this.clearReconnectTimer();
    try { this.inputDisposable?.dispose?.(); } catch {}
    try { this.resizeDisposable?.dispose?.(); } catch {}
    try { this.scrollDisposable?.dispose?.(); } catch {}
    if (this.scrollbarFrame) this.ownerWindow.cancelAnimationFrame(this.scrollbarFrame);
    if (this.scrollbarViewport && this.scrollbarScrollListener) {
      try { this.scrollbarViewport.removeEventListener("scroll", this.scrollbarScrollListener); } catch {}
    }
    try { this.socket?.close?.(); } catch {}
    try { this.resizeObserver?.disconnect?.(); } catch {}
    try { this.themeObserver?.disconnect?.(); } catch {}
    if (this.resizeListener) {
      this.ownerWindow.removeEventListener("resize", this.resizeListener);
      this.ownerWindow.removeEventListener("dock-resize", this.resizeListener);
    }
    if (this.themeChangeListener) this.ownerWindow.removeEventListener("piclaw-theme-change", this.themeChangeListener);
    if (this.mediaQuery && this.mediaQueryListener) {
      if (this.mediaQuery.removeEventListener) this.mediaQuery.removeEventListener("change", this.mediaQueryListener);
      else if (this.mediaQuery.removeListener) this.mediaQuery.removeListener(this.mediaQueryListener);
    }
    try { this.rendererAddon?.dispose?.(); } catch {}
    try { this.fitAddon?.dispose?.(); } catch {}
    try { this.terminal?.dispose?.(); } catch {}
    this.root?.remove?.();
  }
}

export const liteTermPaneExtension = {
  id: "terminal",
  label: "Lite Terminal",
  icon: "terminal",
  capabilities: ["terminal"],
  placement: "dock",
  mount(container, context) {
    return new LiteTermPaneInstance(container, context);
  },
};

export const liteTermTabPaneExtension = {
  id: "terminal-tab",
  label: "Lite Terminal",
  icon: "terminal",
  capabilities: ["terminal"],
  placement: "tabs",
  canHandle(context) {
    return context?.path === TERMINAL_TAB_PATH ? 10_000 : false;
  },
  mount(container, context) {
    return new LiteTermPaneInstance(container, context);
  },
};

function registerLiteTermPanes() {
  const webApi = globalThis.__piclaw_web;
  if (!webApi || typeof webApi.registerPane !== "function") return false;
  webApi.registerPane(liteTermPaneExtension);
  webApi.registerPane(liteTermTabPaneExtension);
  paneRegistered = true;
  console.info("[lite-term] registered xterm.js terminal panes");
  return true;
}

try {
  registerLiteTermPanes();
  if (typeof window !== "undefined") {
    window.addEventListener("piclaw:addons-loaded", () => { try { registerLiteTermPanes(); } catch {} });
  }
} catch (error) {
  console.warn("[lite-term] pane registration failed", error);
}

export function isLiteTermRegistered() {
  return paneRegistered;
}
