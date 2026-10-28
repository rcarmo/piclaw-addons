import { expect, test } from "bun:test";
import { chromium, webkit } from "playwright";

const browserTest = process.env.PICLAW_RUN_OPTIONAL_BROWSER_TESTS === "1" ? test : test.skip;

for (const engine of [chromium, webkit]) browserTest(`${engine.name()}: long session handles truncate inside tiles without displacing status`, async () => {
  const result = await Bun.build({ entrypoints: [import.meta.dir + "/web/index.ts"], target: "browser", format: "iife" });
  expect(result.success).toBe(true);
  const script = await result.outputs[0].text();
  const browser = await engine.launch({ headless: true });
  try {
    for (const width of [320, 759, 760, 1079, 1080, 1440]) for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const name = "operator-control-acceptance-20261023-".repeat(4);
        await page.route("http://dashboard.test/**", route => {
          const path = new URL(route.request().url()).pathname;
          if (path === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><style>body{margin:0;font:14px system-ui}button{font:inherit;box-sizing:border-box}</style>" });
          const sessions = Array.from({ length: 8 }, (_, i) => ({ chat_jid: `web:${name}${i}`, agent_name: name + i, summary: "COBALT-742", last_active_at: new Date().toISOString() }));
          return route.fulfill({ json: path.endsWith("/sessions") ? { sessions } : path.endsWith("/active-chats") ? { chats: [] } : { percent: 6 } });
        });
        await page.goto("http://dashboard.test/");
        await page.evaluate(theme => {
          localStorage.setItem("piclaw:session-dashboard:open", "true");
          document.documentElement.style.cssText = theme === "dark" ? "--bg-primary:#10262b;--bg-secondary:#17373d;--text-primary:#ede8dc;--text-secondary:#b3c4c4" : "--bg-primary:#fff;--bg-secondary:#f7f9fa;--text-primary:#18212b;--text-secondary:#536471";
        }, theme);
        await page.addScriptTag({ content: script });
        await page.waitForSelector(".session-dashboard-name");
        const boxes = await page.locator(".session-dashboard-tile").evaluateAll(tiles => tiles.map(tile => {
          const name = tile.querySelector(".session-dashboard-name") as HTMLElement;
          const status = tile.querySelector(".session-dashboard-status") as HTMLElement;
          const meta = tile.querySelector(".session-dashboard-meta") as HTMLElement;
          const t = tile.getBoundingClientRect(), n = name.getBoundingClientRect(), s = status.getBoundingClientRect(), m = meta.getBoundingClientRect();
          return { nameFits: n.right <= s.left, statusFits: s.right <= t.right - 7, metaFits: m.right <= t.right - 7, clipped: name.scrollWidth > name.clientWidth, ellipsis: getComputedStyle(name).textOverflow, title: name.title, text: name.textContent, tileFits: t.right <= innerWidth, contextFits: tile.querySelector(".session-dashboard-context")!.getBoundingClientRect().right <= t.right - 7 };
        }));
        expect(boxes.length).toBe(width < 760 ? 4 : width < 1080 ? 6 : 8);
        for (const box of boxes) {
          expect(box.nameFits).toBe(true);
          expect(box.statusFits).toBe(true);
          expect(box.metaFits).toBe(true);
          expect(box.contextFits).toBe(true);
          expect(box.tileFits).toBe(true);
          expect(box.clipped).toBe(true);
          expect(box.ellipsis).toBe("ellipsis");
          expect(box.title).toBe(box.text);
        }
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}, 30_000);
