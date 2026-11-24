import { afterAll, beforeAll, expect, test } from "bun:test";
import { settingsBrowserEnabled, settingsPaneFixture } from "../../scripts/lib/settings-pane-browser.js";

const browserTest = settingsBrowserEnabled ? test : test.skip;
let fixture: Awaited<ReturnType<typeof settingsPaneFixture>>;
beforeAll(async () => { if (settingsBrowserEnabled) fixture = await settingsPaneFixture(new URL("./web/index.ts", import.meta.url).pathname); });
afterAll(async () => { await fixture?.close(); });

for (const skin of ["classic", "legacy"] as const) {
  browserTest(`Sample ${skin}: UI-only persistence and keychain save, errors, labels and fallback`, async () => {
    const { page, errors, url } = await fixture.page(skin);
    let cfg = { enabled: false, greeting: "Hello", secret_keychain: "sample-addon/api-key" };
    let hasKey = false, fail = false;
    const configWrites: any[] = [], secretWrites: any[] = [];
    await page.route("**/agent/addons/api/sample-addon/config", async (route: any) => {
      if (route.request().method() === "POST") {
        const patch = route.request().postDataJSON(); configWrites.push(patch);
        if (fail) return route.fulfill({ status: 400, json: { error: "Save failed" } });
        cfg = { ...cfg, ...patch };
      }
      return route.fulfill({ json: { ok: true, config: cfg } });
    });
    await page.route("**/agent/keychain", async (route: any) => {
      if (route.request().method() === "POST") { secretWrites.push(route.request().postDataJSON()); hasKey = true; }
      return route.fulfill({ json: { ok: true, entries: hasKey ? [{ name: cfg.secret_keychain }] : [] } });
    });
    try {
      await page.goto(url);
      const greeting = page.getByLabel("Greeting", { exact: true });
      await greeting.waitFor();
      expect(await greeting.getAttribute("aria-describedby")).toBe("sample-addon-greeting-help");
      expect(await page.getByLabel("API key", { exact: true }).getAttribute("type")).toBe("password");
      expect(await page.locator(".sample-addon-settings").evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await greeting.evaluate((el: HTMLElement) => getComputedStyle(el).borderTopStyle)).toBe("solid");
      await greeting.fill("Browser saved");
      await greeting.press("Enter");
      await page.getByRole("status").filter({ hasText: /^Saved$/ }).waitFor();
      expect(configWrites).toEqual([{ greeting: "Browser saved" }]);
      await page.reload();
      await page.getByLabel("Greeting", { exact: true }).waitFor();
      expect(await page.getByLabel("Greeting", { exact: true }).inputValue()).toBe("Browser saved");
      const secret = page.getByLabel("API key", { exact: true });
      await secret.fill("fixture-only-test-secret");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByTitle("Key in keychain").waitFor();
      expect(secretWrites).toEqual([{ name: cfg.secret_keychain, secret: "fixture-only-test-secret", type: "token" }]);
      expect(await secret.inputValue()).toBe("");
      expect(JSON.stringify(configWrites)).not.toContain("fixture-only-test-secret");
      expect(await page.locator(".sample-addon-settings").innerText()).not.toContain("fixture-only-test-secret");
      fail = true;
      await page.getByLabel("Greeting", { exact: true }).fill("Rejected value");
      await page.getByLabel("Greeting", { exact: true }).press("Enter");
      await page.getByRole("alert").filter({ hasText: "Save failed" }).waitFor();
      expect(cfg.greeting).toBe("Browser saved");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);
}
