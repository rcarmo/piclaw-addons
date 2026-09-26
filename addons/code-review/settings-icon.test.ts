import { expect, test } from 'bun:test';
import { settingsBrowserEnabled, settingsPaneFixture } from '../../scripts/lib/settings-pane-browser.js';

// Exercise the registration object, not merely an SVG string somewhere in the source.
test('Code Review registers a theme-aware Settings navigation icon', async () => {
  const globals = globalThis as any;
  const previous = globals.__piclaw_web;
  let definition: any;
  try {
    globals.__piclaw_web = { registerSettingsPane(value: any) { definition = value; } };
    await import(`./web/index.ts?settings-icon=${Date.now()}`);
    expect(definition?.id).toBe('code-review');
    expect(definition?.label).toBe('Code Review');
    expect(definition?.icon).toContain('<svg');
    expect(definition?.icon).toContain('stroke="currentColor"');
    expect(definition?.icon).toContain('aria-hidden="true"');
    expect(definition?.icon).toContain('viewBox="0 0 24 24"');
  } finally { globals.__piclaw_web = previous; }
});

const browserTest = settingsBrowserEnabled ? test : test.skip;
browserTest('real Classic Settings navigation renders the Code Review icon', async () => {
  const fixture = await settingsPaneFixture(`${import.meta.dir}/web/index.ts`, { realHost: true });
  try {
    for (const colorScheme of ['light', 'dark'] as const) {
      const { page, errors, url } = await fixture.page('classic', 1024, colorScheme);
      await page.route('**/agent/addons/api/code-review/action', (route: any) => {
        const { action } = JSON.parse(route.request().postData() || '{}');
        const result = action === 'getSettings' ? { retentionDays: null } : action === 'cleanup' ? { deletedCount: 0 } : [];
        return route.fulfill({ json: { ok: true, result } });
      });
      await page.goto(url);
      const item = page.locator('.settings-nav-item').filter({ hasText: 'Code Review' });
      await item.waitFor();
      const icon = item.locator('.settings-nav-icon svg');
      expect(await icon.count()).toBe(1);
      expect(await icon.getAttribute('aria-hidden')).toBe('true');
      const style = await icon.evaluate((element: SVGElement) => {
        const box = element.getBoundingClientRect();
        return { width: box.width, height: box.height, stroke: getComputedStyle(element).stroke, color: getComputedStyle(element).color };
      });
      expect(style.width).toBeGreaterThan(0);
      expect(style.height).toBeGreaterThan(0);
      expect(style.stroke).toBe(style.color);
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await fixture.close(); }
}, 30000);
