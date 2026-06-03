import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  buildLiteTermTheme,
  buildLiteTermWebSocketUrl,
  getOrCreateAnonymousTerminalClientToken,
  liteTermPaneExtension,
  liteTermTabPaneExtension,
} from "./web/index.ts";

function fakeWindow(protocol = "https:", host = "example.test") {
  return {
    location: { protocol, host },
    localStorage: new MapStorage(),
    crypto: { randomUUID: () => "uuid-token" },
    matchMedia: () => ({ matches: true }),
  } as any;
}

class MapStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const addonDir = fileURLToPath(new URL(".", import.meta.url));

test("buildLiteTermWebSocketUrl uses wss for https and includes handoff/client", () => {
  const url = buildLiteTermWebSocketUrl("/terminal/ws", "handoff-1", "client-1", fakeWindow());
  expect(url).toBe("wss://example.test/terminal/ws?handoff=handoff-1&client=client-1");
});

test("buildLiteTermWebSocketUrl uses ws for http", () => {
  const url = buildLiteTermWebSocketUrl("/terminal/ws", null, null, fakeWindow("http:", "localhost:8080"));
  expect(url).toBe("ws://localhost:8080/terminal/ws");
});

test("anonymous terminal client token is stable in local storage", () => {
  const win = fakeWindow();
  expect(getOrCreateAnonymousTerminalClientToken(win)).toBe("uuid-token");
  expect(getOrCreateAnonymousTerminalClientToken(win)).toBe("uuid-token");
});

test("lite-term pane extensions replace Piclaw terminal pane IDs", () => {
  expect(liteTermPaneExtension.id).toBe("terminal");
  expect(liteTermPaneExtension.placement).toBe("dock");
  expect(liteTermTabPaneExtension.id).toBe("terminal-tab");
  expect(liteTermTabPaneExtension.canHandle({ path: "piclaw://terminal" })).toBe(10_000);
  expect(liteTermTabPaneExtension.canHandle({ path: "README.md" })).toBe(false);
});

test("vendored xterm runtime and addon files are present", () => {
  const expected = [
    "xterm.mjs",
    "xterm.css",
    "addon-attach.mjs",
    "addon-canvas.js",
    "addon-clipboard.mjs",
    "addon-fit.mjs",
    "addon-image.mjs",
    "addon-ligatures.mjs",
    "addon-progress.mjs",
    "addon-search.mjs",
    "addon-serialize.mjs",
    "addon-unicode-graphemes.mjs",
    "addon-unicode11.mjs",
    "addon-web-links.mjs",
    "addon-webgl.mjs",
  ];
  for (const file of expected) {
    expect(existsSync(join(addonDir, "web", "vendor", file))).toBe(true);
  }
});

test("vendored ligatures bundle remains safe after Piclaw asset transpilation", async () => {
  const source = await Bun.file(join(addonDir, "web", "vendor", "addon-ligatures.mjs")).text();
  const transpiled = new Bun.Transpiler({ loader: "js" }).transformSync(source);
  expect(transpiled).toContain("globalThis.require");
  expect(transpiled).not.toContain('"function" < "u" ? require');
  expect(transpiled).not.toContain("return require.apply");
});

test("Lite Term runtime includes heartbeat and reconnect safeguards", async () => {
  const source = await Bun.file(join(addonDir, "web", "index.ts")).text();
  expect(source).toContain("TERMINAL_HEARTBEAT_MS");
  expect(source).toContain('type: "ping"');
  expect(source).toContain("scheduleReconnect");
  expect(source).toContain("installTerminalSocketBridge");
  expect(source).toContain("this.socket !== socket");
});

test("Lite Term uses xterm overviewRuler width to size the native scrollbar", async () => {
  const source = await Bun.file(join(addonDir, "web", "index.ts")).text();
  expect(source).toContain("overviewRuler: { width: 2 },");
  expect(source).not.toContain("lite-terminal-scrollbar-thumb");
  expect(source).not.toContain("syncOverlayScrollbar");
  expect(source).not.toContain(".xterm-scrollable-element > .scrollbar.vertical");
});

test("vendored xterm ESM modules expose expected addon classes", async () => {
  const vendorUrl = new URL("./web/vendor/", import.meta.url);
  const [xterm, attach, fit, ligatures, webgl, clipboard, image, search, serialize, unicode11, webLinks, progress, unicodeGraphemes] = await Promise.all([
    import(new URL("xterm.mjs", vendorUrl).href),
    import(new URL("addon-attach.mjs", vendorUrl).href),
    import(new URL("addon-fit.mjs", vendorUrl).href),
    import(new URL("addon-ligatures.mjs", vendorUrl).href),
    import(new URL("addon-webgl.mjs", vendorUrl).href),
    import(new URL("addon-clipboard.mjs", vendorUrl).href),
    import(new URL("addon-image.mjs", vendorUrl).href),
    import(new URL("addon-search.mjs", vendorUrl).href),
    import(new URL("addon-serialize.mjs", vendorUrl).href),
    import(new URL("addon-unicode11.mjs", vendorUrl).href),
    import(new URL("addon-web-links.mjs", vendorUrl).href),
    import(new URL("addon-progress.mjs", vendorUrl).href),
    import(new URL("addon-unicode-graphemes.mjs", vendorUrl).href),
  ]);
  expect(typeof xterm.Terminal).toBe("function");
  expect(typeof attach.AttachAddon).toBe("function");
  expect(typeof fit.FitAddon).toBe("function");
  expect(typeof ligatures.LigaturesAddon).toBe("function");
  expect(typeof webgl.WebglAddon).toBe("function");
  expect(typeof clipboard.ClipboardAddon).toBe("function");
  expect(typeof image.ImageAddon).toBe("function");
  expect(typeof search.SearchAddon).toBe("function");
  expect(typeof serialize.SerializeAddon).toBe("function");
  expect(typeof unicode11.Unicode11Addon).toBe("function");
  expect(typeof webLinks.WebLinksAddon).toBe("function");
  expect(typeof progress.ProgressAddon).toBe("function");
  expect(typeof unicodeGraphemes.UnicodeGraphemesAddon).toBe("function");
});

test("buildLiteTermTheme returns a full xterm color theme", () => {
  const previous = (globalThis as any).getComputedStyle;
  (globalThis as any).getComputedStyle = () => ({
    getPropertyValue(name: string) {
      const values: Record<string, string> = {
        "--bg-primary": "#0d1117",
        "--text-primary": "#c9d1d9",
        "--accent-color": "#58a6ff",
        "--danger-color": "#ff7b72",
        "--success-color": "#7ee787",
        "--bg-hover": "#161b22",
      };
      return values[name] || "";
    },
  });
  try {
    const doc = { documentElement: { getAttribute: () => "dark", classList: { contains: () => false } }, body: { classList: { contains: () => false } } } as any;
    const theme = buildLiteTermTheme(fakeWindow(), doc);
    expect(theme.background).toBe("#0d1117");
    expect(theme.foreground.startsWith("#")).toBe(true);
    expect(theme.brightCyan.startsWith("#")).toBe(true);
    expect(theme.selectionBackground.startsWith("#")).toBe(true);
  } finally {
    (globalThis as any).getComputedStyle = previous;
  }
});
