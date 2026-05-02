import { expect } from '../support/world';
import { sel } from '../support/selectors';
import type { StepDefinition } from '../support/gherkin-runner';
import type { Page } from '@playwright/test';

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press('Meta+Comma');
  try {
    await page.waitForSelector(sel.settingsDialog, { timeout: 2500 });
    return;
  } catch {
    const gear = page.locator(sel.settingsTrigger).first();
    if (await gear.isVisible({ timeout: 1000 }).catch(() => false)) {
      await gear.click();
    } else {
      const menu = page.getByRole('button', { name: /menu/i }).first();
      await expect(menu).toBeVisible({ timeout: 3000 });
      await menu.click();
      await page.getByText(/settings/i).first().click();
    }
    await page.waitForSelector(sel.settingsDialog, { timeout: 5000 });
  }
}

async function selectSettingsPane(page: Page, label: string): Promise<void> {
  const dialog = page.locator(sel.settingsDialog).first();
  await expect(dialog).toBeVisible({ timeout: 5000 });
  const candidates = dialog.locator(`button, [role="tab"], [data-pane], .settings-nav-item`).filter({ hasText: label });
  if (await candidates.count()) {
    await candidates.first().click();
  } else {
    await dialog.getByText(label, { exact: false }).first().click();
  }
  await expect(dialog.getByText(label, { exact: false }).first()).toBeVisible({ timeout: 5000 });
}

export const steps: StepDefinition[] = [
  {
    pattern: /^the "([^"]+)" add-on is installed$/,
    async handler(ctx, slug) {
      ctx.state.addonSlug = slug;
      const response = await ctx.page.request.get('/agent/addons');
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      const addon = (data.addons || []).find((entry: any) => entry.slug === slug);
      expect(addon, `Add-on ${slug} should be present in catalog response`).toBeTruthy();
      expect(addon.installedVersion || addon.installed, `Add-on ${slug} should be installed in the test workspace`).toBeTruthy();
    },
  },
  {
    pattern: /^I am on the main chat$/,
    async handler(ctx) {
      await ctx.page.goto(process.env.PICLAW_E2E_URL || 'http://localhost:3000');
      await ctx.page.waitForLoadState('domcontentloaded');
      await ctx.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    },
  },
  {
    pattern: /^I open Settings$/,
    async handler(ctx) {
      await openSettings(ctx.page);
    },
  },
  {
    pattern: /^I select the "([^"]+)" settings pane$/,
    async handler(ctx, label) {
      await selectSettingsPane(ctx.page, label);
    },
  },
  {
    pattern: /^the "([^"]+)" settings pane is open$/,
    async handler(ctx, label) {
      await openSettings(ctx.page);
      await selectSettingsPane(ctx.page, label);
    },
  },
  {
    pattern: /^I reload the settings pane$/,
    async handler(ctx) {
      await ctx.page.keyboard.press('Escape');
      await ctx.page.waitForTimeout(250);
      await openSettings(ctx.page);
      const label = String(ctx.state.settingsPaneLabel || 'Sample Addon');
      await selectSettingsPane(ctx.page, label);
    },
  },
];
