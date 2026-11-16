import { afterAll, beforeAll, expect, test } from "bun:test";
import { settingsBrowserEnabled, settingsPaneFixture } from "../../scripts/lib/settings-pane-browser.js";

const browserTest = settingsBrowserEnabled ? test : test.skip;
let fixture: Awaited<ReturnType<typeof settingsPaneFixture>>;
beforeAll(async () => { if (settingsBrowserEnabled) fixture = await settingsPaneFixture(new URL("./web/index.ts", import.meta.url).pathname); });
afterAll(async () => { await fixture?.close(); });

for (const skin of ["classic", "visual", "legacy"]) {
  browserTest(`Delegate ${skin}: unchanged approval/exclusion requests, rollback and bounded layout`, async () => {
    const { page, errors, url } = await fixture.page(skin);
    let config = { searchable_providers: [] as string[], excluded_providers: ["alpha", "beta"], excluded_models: [] as string[] };
    let rejectSave = false, rejectRefresh = false;
    const writes: any[] = [], refreshes: any[] = [];
    await page.route("**/agent/addons/api/delegate/models", async (route: any) => {
      if (route.request().method() === "POST") refreshes.push(route.request().postDataJSON());
      if (rejectRefresh) return route.fulfill({ status: 503, json: { error: "Models unavailable" } });
      return route.fulfill({ json: { config, cli: '/runtime/bun /release/pi/dist/bundle/cli.js', cli_package_version: '1.0.1', providers: ["alpha", "beta"].map(provider => ({ provider, modelCount: 20 })), candidates: Array.from({ length: 35 }, (_, i) => ({ id: `alpha/model-${i}`, tier: 1, family: "fixture", classificationRule: "test" })), rejected_models: [{ fullId: "beta/model", rejection_reason: "unapproved" }] } });
    });
    await page.route("**/agent/addons/api/delegate/config", async (route: any) => {
      const patch = route.request().postDataJSON(); writes.push(patch);
      if (rejectSave) return route.fulfill({ status: 400, json: { error: "Save failed" } });
      config = { ...config, ...patch };
      return route.fulfill({ json: { ok: true, config } });
    });
    try {
      await page.goto(url);
      const alpha = page.getByRole("radiogroup", { name: "alpha mode" });
      await alpha.waitFor();
      expect(await page.locator('.delegate-settings').innerText()).toContain('CLI: /runtime/bun /release/pi/dist/bundle/cli.js · Pi package: 1.0.1');
      expect(await alpha.getByLabel("Exclude", { exact: true }).isChecked()).toBe(true);
      expect(await page.locator(".delegate-settings").evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await page.locator(".delegate-scroll").first().evaluate((el: HTMLElement) => getComputedStyle(el).maxHeight)).toBe("180px");
      await page.getByLabel("Filter providers", { exact: true }).fill("alpha");
      expect(await page.getByRole("radiogroup").count()).toBe(1);
      await page.getByLabel("Filter providers", { exact: true }).fill("");
      await alpha.getByLabel("Approved", { exact: true }).check();
      await page.getByRole("status").filter({ hasText: "Set alpha to search" }).waitFor();
      expect(writes[0]).toEqual({ searchable_providers: ["alpha"], excluded_providers: ["beta"] });
      await page.getByLabel("Excluded model patterns", { exact: true }).fill("z*, a*");
      await page.getByRole("button", { name: "Save exclusions" }).click();
      await page.getByRole("status").filter({ hasText: "Saved model exclusions" }).waitFor();
      expect(writes[1]).toEqual({ excluded_models: ["a*", "z*"] });
      rejectSave = true;
      await alpha.getByLabel("Exclude", { exact: true }).check();
      await page.getByRole("alert").filter({ hasText: "Save failed" }).waitFor();
      expect(await alpha.getByLabel("Approved", { exact: true }).isChecked()).toBe(true);
      expect(config.searchable_providers).toEqual(["alpha"]);
      rejectSave = false; rejectRefresh = true;
      await page.getByLabel("Excluded model patterns", { exact: true }).fill("new*");
      await page.getByRole("button", { name: "Save exclusions" }).click();
      await page.getByRole("alert").filter({ hasText: "Saved model exclusions. Refresh failed:" }).waitFor();
      expect(config.excluded_models).toEqual(["new*"]);
      expect(await page.getByLabel("Excluded model patterns", { exact: true }).inputValue()).toBe("new*");
      rejectRefresh = false;
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Model list refreshed" }).waitFor();
      expect(refreshes).toEqual([{ refresh: true }]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);
}
