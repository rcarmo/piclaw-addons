import { expect } from '../../../../tests/addon-e2e/support/world';
import type { StepDefinition } from '../../../../tests/addon-e2e/support/gherkin-runner';
import type { Locator, Route } from '@playwright/test';

const FREE_ALPHA = {
  ref: 'free-alpha/zero-text', provider: 'free-alpha', provider_name: 'Free Alpha', model: 'zero-text', name: 'Zero Text',
  context_window: 131072, max_tokens: 32768, reasoning: true, inputs: ['text'], configured: true,
  provider_enabled: true, model_enabled: false, in_scope: true, state: 'disabled', priority: null, active: false,
  health: { state: 'healthy', cooldown_until: null, last_error: null, last_success_at: null },
};
const FREE_BETA = {
  ref: 'free-beta/zero-vision', provider: 'free-beta', provider_name: 'Free Beta', model: 'zero-vision', name: 'Zero Vision',
  context_window: 262144, max_tokens: 65536, reasoning: true, inputs: ['text', 'image'], configured: true,
  provider_enabled: true, model_enabled: true, in_scope: true, state: 'eligible', priority: 0, active: true,
  health: { state: 'healthy', cooldown_until: null, last_error: null, last_success_at: '2026-09-03T10:00:00.000Z' },
};

function pane(ctx: any): Locator {
  return ctx.page.locator('[data-testid="cheapskate-settings"]').first();
}

function status(state?: any) {
  const models = { 'free-beta/zero-vision': { enabled: true }, ...(state?.models || {}) };
  const priority = state?.priority || ['free-beta/zero-vision'];
  const enabledAlpha = models['free-alpha/zero-text']?.enabled === true;
  return {
    ok: true,
    config: { version: 2, enabled: true, providers: {}, models, priority },
    virtual_model_registered: true,
    active_ref: 'free-beta/zero-vision',
    candidates: [
      { ...FREE_ALPHA, model_enabled: enabledAlpha, state: enabledAlpha ? 'eligible' : 'disabled', priority: priority.indexOf(FREE_ALPHA.ref) >= 0 ? priority.indexOf(FREE_ALPHA.ref) : null },
      { ...FREE_BETA, priority: priority.indexOf(FREE_BETA.ref) >= 0 ? priority.indexOf(FREE_BETA.ref) : null },
    ],
    excluded_costs: { positive: 1, unknown_or_malformed: 1, recursive: 1 },
    empty_reason: null,
  };
}

async function installMock(ctx: any): Promise<void> {
  if (ctx.state.cheapskateRouteInstalled) return;
  ctx.state.cheapskateRouteInstalled = true;
  ctx.state.cheapskateConfig = {};
  await ctx.page.route('**/agent/addons/api/cheapskate/config**', async (route: Route) => {
    if (route.request().method() === 'POST') {
      const patch = route.request().postDataJSON() || {};
      const current = ctx.state.cheapskateConfig || {};
      ctx.state.cheapskateConfig = {
        ...current,
        ...(patch.models ? { models: { ...(current.models || {}), ...patch.models } } : {}),
        ...(patch.priority ? { priority: patch.priority } : {}),
      };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status(ctx.state.cheapskateConfig)) });
  });
  await ctx.page.reload();
  await ctx.page.waitForLoadState('domcontentloaded');
  await ctx.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
}

export const steps: StepDefinition[] = [
  {
    pattern: /^a mixed zero-cost and paid Cheapskate catalogue is available$/,
    async handler(ctx) {
      ctx.state.settingsPaneLabel = 'Cheapskate';
      await installMock(ctx);
    },
  },
  {
    pattern: /^I should see the free-model filter$/,
    async handler(ctx) {
      await expect(pane(ctx).getByRole('searchbox', { name: 'Filter free models' })).toBeVisible();
      await expect(pane(ctx).getByRole('combobox', { name: 'Filter provider' })).toBeVisible();
    },
  },
  {
    pattern: /^I should see only exact-zero Cheapskate candidates$/,
    async handler(ctx) {
      await expect(pane(ctx).locator('[data-model-ref]')).toHaveCount(2);
      await expect(pane(ctx).getByText('free-alpha/zero-text', { exact: true })).toBeVisible();
      await expect(pane(ctx).getByText('free-beta/zero-vision', { exact: true })).toBeVisible();
      await expect(pane(ctx).getByText('paid/model')).toHaveCount(0);
      await expect(pane(ctx).getByText('1 positive-price')).toBeVisible();
    },
  },
  {
    pattern: /^I should see catalogue-derived model capabilities$/,
    async handler(ctx) {
      const vision = pane(ctx).locator('[data-model-ref="free-beta/zero-vision"]');
      await expect(vision.getByText('context 262K')).toBeVisible();
      await expect(vision.getByText('output 66K')).toBeVisible();
      await expect(vision.getByText('text + image')).toBeVisible();
    },
  },
  {
    pattern: /^I filter Cheapskate models by text and provider$/,
    async handler(ctx) {
      await pane(ctx).getByRole('searchbox', { name: 'Filter free models' }).fill('vision');
      await pane(ctx).getByRole('combobox', { name: 'Filter provider' }).selectOption('free-beta');
    },
  },
  {
    pattern: /^only matching zero-cost Cheapskate candidates remain$/,
    async handler(ctx) {
      await expect(pane(ctx).locator('[data-model-ref]')).toHaveCount(1);
      await expect(pane(ctx).getByText('free-beta/zero-vision', { exact: true })).toBeVisible();
    },
  },
  {
    pattern: /^I enable and prioritise a zero-cost Cheapskate model$/,
    async handler(ctx) {
      const checkbox = pane(ctx).getByRole('checkbox', { name: 'Enable free-alpha/zero-text' });
      await checkbox.click();
      await expect.poll(() => Boolean(ctx.state.cheapskateConfig?.models?.['free-alpha/zero-text']?.enabled)).toBe(true);
      await expect(checkbox).toBeChecked();
      await pane(ctx).getByRole('button', { name: 'Raise priority free-alpha/zero-text' }).click();
    },
  },
  {
    pattern: /^the Cheapskate model enablement and priority should persist$/,
    async handler(ctx) {
      const checkbox = pane(ctx).getByRole('checkbox', { name: 'Enable free-alpha/zero-text' });
      await expect(checkbox).toBeChecked();
      await expect(pane(ctx).locator('[data-model-ref="free-alpha/zero-text"]').getByText('priority 1')).toBeVisible();
    },
  },
];
