import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { chromium } from "playwright";

type Args = {
  url: string;
  pane: string;
  out: string;
  timeoutMs: number;
};

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    values.set(key, value);
    i += 1;
  }

  const url = values.get("url")?.trim() || "http://192.168.1.78:8080";
  const pane = values.get("pane")?.trim();
  const out = values.get("out")?.trim();
  const timeoutMs = Number(values.get("timeout") || 30000);

  if (!pane) throw new Error("Missing --pane <label>");
  if (!out) throw new Error("Missing --out <path>");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout must be a positive number");

  return { url, pane, out: resolve(out), timeoutMs };
}

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  await mkdir(dirname(args.out), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  try {
    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    await page.waitForSelector(".compose-box", { timeout: 60000 });
    await sleep(3000);

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("piclaw:open-settings"));
    });

    await page.waitForFunction(() => !!document.querySelector('.settings-dialog, .settings-dialog-backdrop'), { timeout: args.timeoutMs });
    await sleep(500);

    const clicked = await page.evaluate((paneLabel) => {
      const label = String(paneLabel || "").trim().toLowerCase();
      const nodes = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], .settings-nav-item')) as HTMLElement[];
      const target = nodes.find((node) => {
        const text = (node.textContent || "").trim().toLowerCase();
        return text === label || text.includes(label);
      });
      if (!target) return false;
      target.click();
      return true;
    }, args.pane);

    if (!clicked) throw new Error(`Could not find settings pane control for ${args.pane}`);

    await page.waitForFunction((paneLabel) => {
      const text = document.body?.innerText || "";
      return text.toLowerCase().includes(String(paneLabel || "").trim().toLowerCase());
    }, args.pane, { timeout: args.timeoutMs });
    await sleep(700);

    const dialog = page.locator('.settings-dialog');
    if (await dialog.count()) {
      await dialog.first().screenshot({ path: args.out });
    } else {
      await page.screenshot({ path: args.out, fullPage: true });
    }

    console.log(args.out);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
