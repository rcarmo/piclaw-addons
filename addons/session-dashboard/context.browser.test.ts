import { expect, test } from 'bun:test';
import { join } from 'node:path';

// Self-contained disposable HTTP fixture; never targets an installed runtime.
const enabled = process.env.PICLAW_RUN_OPTIONAL_BROWSER_TESTS === '1' && process.env.PICLAW_E2E_DISPOSABLE === '1';
for (const engine of ['chromium', 'webkit'] as const) for (const touch of [false, true]) {
  test.skipIf(!enabled)(`${engine} Dashboard ${touch ? 'touch' : 'desktop'} projects HTTP and live nullable context`, async () => {
    const { chromium, webkit } = await import('playwright');
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, 'web/index.ts')], target: 'browser', format: 'esm' });
    if (!built.success) throw Error(String(built.logs));
    const script = await built.outputs[0].text();
    let context: Record<string, number | null> = { percent: null, tokens: null, contextWindow: null };
    const requests: string[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const url = new URL(request.url); requests.push(url.pathname);
      if (url.pathname === '/') return new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main>Disposable Dashboard fixture</main><script type="module" src="/dashboard.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
      if (url.pathname === '/dashboard.js') return new Response(script, { headers: { 'Content-Type': 'text/javascript' } });
      if (url.pathname === '/agent/addons/api/session-dashboard/sessions') return Response.json({ sessions: [{ chat_jid: 'web:default', agent_name: 'fixture', summary: 'Context fixture' }] });
      if (url.pathname === '/agent/active-chats') return Response.json({ chats: [] });
      if (url.pathname === '/agent/context') return Response.json(context);
      return new Response('Unexpected fixture request', { status: 404 });
    } });
    const browser = await ({ chromium, webkit })[engine].launch({ headless: true });
    const browserContext = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: touch, isMobile: touch });
    try {
      const page = await browserContext.newPage();
      const errors: string[] = []; page.on('pageerror', error => { errors.push(String(error)); console.error('DASHBOARD_PAGE_ERROR', String(error)); });
      await page.goto(`http://127.0.0.1:${server.port}/`);
      const toggle = page.getByRole('button', { name: /^Show recent sessions/ });
      if (touch) await toggle.tap(); else await toggle.click();
      const label = page.locator('.session-dashboard-context');
      await page.waitForFunction(() => document.querySelector('.session-dashboard-context')?.textContent === 'context unknown');
      expect(await label.textContent()).toBe('context unknown');
      const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
      for (const value of [0, 80]) {
        context = { percent: value, tokens: value * 1000, contextWindow: 100000 };
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/agent/context');
        if (touch) await refresh.tap(); else await refresh.click();
        await response;
        await page.waitForFunction(value => document.querySelector('.session-dashboard-context')?.textContent === `${value}% context`, value);
        expect(await label.textContent()).toBe(`${value}% context`);
      }
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('piclaw-extension-ui:status', { detail: { key: 'context_usage', chat_jid: 'web:default', context_usage: { percent: null, tokens: null, contextWindow: null } } })));
      await page.waitForFunction(() => document.querySelector('.session-dashboard-context')?.textContent === 'context unknown');
      expect(await label.textContent()).toBe('context unknown');
      expect(await page.locator('.session-dashboard-context-meter span').evaluate(node => (node as HTMLElement).style.width)).toBe('0%');
      expect(requests.some(path => path.includes('/agent/models'))).toBe(false);
      expect(errors).toEqual([]);
    } finally { await browserContext.close(); await browser.close(); server.stop(true); }
  }, 60000);
}
