import { test as base, expect, type Page } from '@playwright/test';
import { authenticatedContext } from './auth';

export interface AddonWorldState {
  addonSlug?: string;
  [key: string]: unknown;
}

export interface AddonStepContext {
  page: Page;
  addonSlug: string;
  featureFile: string;
  state: AddonWorldState;
}

export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ browser }, use) => {
    const baseURL = process.env.PICLAW_E2E_URL || 'http://localhost:3000';
    const context = await authenticatedContext(browser, baseURL);
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await use(page);
    await context.close();
  },
});

export { expect };
