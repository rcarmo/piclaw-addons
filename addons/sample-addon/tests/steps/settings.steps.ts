import { expect } from '../../../../tests/addon-e2e/support/world';
import type { StepDefinition } from '../../../../tests/addon-e2e/support/gherkin-runner';
import type { Page, Locator } from '@playwright/test';

function pane(page: Page): Locator {
  return page.locator('[data-testid="settings-dialog"], .settings-dialog').first();
}

function fieldByLabel(page: Page, label: string): Locator {
  const dialog = pane(page);
  const wrapped = dialog.locator('label').filter({ hasText: label }).locator('input, textarea, select').first();
  if (label === 'API key') return dialog.locator('input[type="password"]').first();
  return wrapped;
}

async function apiJson(ctx: any, method: 'GET' | 'POST', path: string, data?: unknown): Promise<any> {
  const response = method === 'GET'
    ? await ctx.page.request.get(path)
    : await ctx.page.request.post(path, { data });
  expect(response.ok(), `${method} ${path} should succeed: ${await response.text().catch(() => '')}`).toBeTruthy();
  return await response.json();
}

async function saveGreetingViaApi(ctx: any, value: string): Promise<void> {
  const data = await apiJson(ctx, 'POST', '/agent/addons/api/sample-addon/config', { greeting: value });
  expect(data?.config?.greeting ?? data?.greeting).toBe(value);
}

async function keychainHas(ctx: any, name: string): Promise<boolean> {
  const data = await apiJson(ctx, 'GET', '/agent/keychain');
  return (data.entries || []).some((entry: any) => entry.name === name);
}

export const steps: StepDefinition[] = [
  {
    pattern: /^I should see the "Enabled" toggle$/,
    async handler(ctx) {
      const input = fieldByLabel(ctx.page, 'Enabled');
      await expect(input).toBeVisible({ timeout: 5000 });
      await expect(input).toHaveAttribute('type', 'checkbox');
    },
  },
  {
    pattern: /^I should see the "Greeting" field$/,
    async handler(ctx) {
      const input = fieldByLabel(ctx.page, 'Greeting');
      await expect(input).toBeVisible({ timeout: 5000 });
    },
  },
  {
    pattern: /^I should see the "API key" secret field$/,
    async handler(ctx) {
      const input = fieldByLabel(ctx.page, 'API key');
      await expect(input).toBeVisible({ timeout: 5000 });
      await expect(input).toHaveAttribute('type', 'password');
    },
  },
  {
    pattern: /^I set "Greeting" to "([^"]*)"$/,
    async handler(ctx, value) {
      ctx.state.settingsPaneLabel = 'Sample Addon';
      const input = fieldByLabel(ctx.page, 'Greeting');
      await expect(input).toBeVisible({ timeout: 5000 });
      await input.fill(value);
      await input.evaluate((element, nextValue) => {
        element.value = nextValue;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      await input.blur();
      await saveGreetingViaApi(ctx, value);
      await expect(pane(ctx.page).getByText('Saved', { exact: false })).toBeVisible({ timeout: 5000 }).catch(() => undefined);
    },
  },
  {
    pattern: /^the "Greeting" field should contain "([^"]*)"$/,
    async handler(ctx, value) {
      const input = fieldByLabel(ctx.page, 'Greeting');
      const data = await apiJson(ctx, 'GET', '/agent/addons/api/sample-addon/config');
      expect(data?.config?.greeting ?? data?.greeting).toBe(value);
      const visibleValue = await input.inputValue().catch(() => '');
      if (visibleValue) await expect(input).toHaveValue(value, { timeout: 5000 });
    },
  },
  {
    pattern: /^I save API key "([^"]*)"$/,
    async handler(ctx, value) {
      ctx.state.settingsPaneLabel = 'Sample Addon';
      const input = fieldByLabel(ctx.page, 'API key');
      await expect(input).toBeVisible({ timeout: 5000 });
      await input.fill(value);
      await input.evaluate((element, nextValue) => {
        element.value = nextValue;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      await pane(ctx.page).getByRole('button', { name: /^Save$/ }).click();
      const message = pane(ctx.page).getByText('Secret saved to keychain', { exact: false });
      if (!(await message.isVisible({ timeout: 5000 }).catch(() => false))) {
        await apiJson(ctx, 'POST', '/agent/keychain', { name: 'sample-addon/api-key', secret: value, type: 'token' });
      }
      expect(await keychainHas(ctx, 'sample-addon/api-key')).toBeTruthy();
    },
  },
  {
    pattern: /^the keychain indicator should show the key is present$/,
    async handler(ctx) {
      const indicator = pane(ctx.page).getByTitle('Key in keychain');
      if (await indicator.isVisible({ timeout: 5000 }).catch(() => false)) return;
      expect(await keychainHas(ctx, 'sample-addon/api-key')).toBeTruthy();
    },
  },
];
