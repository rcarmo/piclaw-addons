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
      await expect(pane(ctx.page).getByText('Saved', { exact: false })).toBeVisible({ timeout: 5000 });
    },
  },
  {
    pattern: /^the "Greeting" field should contain "([^"]*)"$/,
    async handler(ctx, value) {
      const input = fieldByLabel(ctx.page, 'Greeting');
      await expect(input).toHaveValue(value, { timeout: 5000 });
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
      await expect(pane(ctx.page).getByText('Secret saved to keychain', { exact: false })).toBeVisible({ timeout: 5000 });
    },
  },
  {
    pattern: /^the keychain indicator should show the key is present$/,
    async handler(ctx) {
      await expect(pane(ctx.page).getByTitle('Key in keychain')).toBeVisible({ timeout: 5000 });
    },
  },
];
