import { chromium } from "playwright";

const url = process.argv[2] || "http://192.168.1.78:8080";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector(".compose-box", { timeout: 60_000 });
  await page.waitForTimeout(2_000);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("piclaw:open-settings")));
  const pane = page.getByText("Remote Peer", { exact: true });
  await pane.waitFor({ timeout: 30_000 });
  await pane.click();
  await page.getByText("Health & identity", { exact: true }).waitFor({ timeout: 30_000 });

  const dashboard = await page.evaluate(async () => {
    const response = await fetch("/agent/addons/api/remote-peer/dashboard");
    return { status: response.status, body: await response.json() };
  });
  if (dashboard.status !== 200) throw new Error(`dashboard status ${dashboard.status}`);
  const serialized = JSON.stringify(dashboard.body);
  for (const forbidden of ["private_key", "target_chat_jid", "reply_token", "token_hash", "database.path", "/workspace/"]) {
    if (serialized.includes(forbidden)) throw new Error(`dashboard leaked ${forbidden}`);
  }

  const instance = page.getByPlaceholder("Instance name");
  await instance.fill("UI test peer");
  await instance.blur();
  await page.waitForTimeout(700);
  const saved = await page.evaluate(async () => (await fetch("/agent/addons/api/remote-peer/config")).json());
  if (saved.config?.instanceName !== "UI test peer") throw new Error("instance name did not save");

  const confirmation = await page.evaluate(async () => {
    const response = await fetch("/agent/addons/api/remote-peer/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revoke", peer: "missing", confirmation: "wrong" }),
    });
    return { status: response.status, body: await response.json() };
  });
  if (confirmation.status < 400 || !String(confirmation.body.error || "").includes("Revocation requires")) {
    throw new Error("revoke confirmation was not enforced");
  }

  const text = await page.locator("body").innerText();
  for (const required of ["Pairing & peers", "Advertised agents & delivery", "FAILED RECEIPTS"]) {
    if (!text.includes(required)) throw new Error(`missing UI section: ${required}`);
  }
  console.log(JSON.stringify({ ok: true, dashboard: dashboard.body.health, config: saved.config }, null, 2));
} finally {
  await browser.close();
}
