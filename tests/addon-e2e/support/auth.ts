import type { Browser, BrowserContext } from '@playwright/test';

function internalSecret(): string {
  return process.env.PICLAW_INTERNAL_SECRET || process.env.PICLAW_WEB_INTERNAL_SECRET || '';
}

function parseCookie(setCookie: string, baseURL: string) {
  const [nameValue] = setCookie.split(';');
  const eq = nameValue.indexOf('=');
  if (eq < 0) throw new Error('Invalid Set-Cookie header from E2E auth');
  return {
    name: nameValue.slice(0, eq).trim(),
    value: nameValue.slice(eq + 1).trim(),
    url: baseURL,
  };
}

export async function authenticatedContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const secret = internalSecret();
  if (!secret) throw new Error('PICLAW_INTERNAL_SECRET is required for add-on E2E auth');

  const resp = await fetch(`${baseURL}/auth/e2e/bootstrap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Piclaw-Internal-Secret': secret,
      'Authorization': `Bearer ${secret}`,
    },
    body: JSON.stringify({ secret }),
  });
  if (!resp.ok) throw new Error(`E2E auth failed: HTTP ${resp.status} ${await resp.text()}`);

  const setCookie = resp.headers.get('set-cookie');
  if (!setCookie) throw new Error('No Set-Cookie from E2E auth');

  const context = await browser.newContext();
  await context.addCookies([parseCookie(setCookie, baseURL)]);
  return context;
}
