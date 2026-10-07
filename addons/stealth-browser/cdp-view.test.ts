import { expect, test } from 'bun:test';
import { reserveViewerPort, registerStealthViewer, assertStealthToolControl } from './cdp-view.js';

test('viewer uses an owned loopback port and optional host registration', async () => {
  const reservation = await reserveViewerPort(); expect(reservation.port).toBeGreaterThan(1024); await reservation.release();
  const globals = globalThis as any;
  const old = globals.__piclaw_registerCdpViewSource, oldControl = globals.__piclaw_assertCdpViewToolControl;
  let source: any, closed = false;
  try {
    globals.__piclaw_registerCdpViewSource = (value: any) => { source = value; return () => { closed = true; }; };
    const unregister = registerStealthViewer(reservation.port);
    expect(source).toEqual({ id: 'stealth', label: 'Stealth Browser', port: reservation.port, restoreViewport: 'clear' });
    unregister(); expect(closed).toBe(true);
    globals.__piclaw_assertCdpViewToolControl = () => { throw Error('manual control'); };
    expect(assertStealthToolControl).toThrow('manual control');
    delete globals.__piclaw_registerCdpViewSource; expect(() => registerStealthViewer(reservation.port)()).not.toThrow();
  } finally { globals.__piclaw_registerCdpViewSource = old; globals.__piclaw_assertCdpViewToolControl = oldControl; }
});

const binary = process.env.PICLAW_TEST_CHROMIUM;
(binary ? test : test.skip)('Mochi retains its pipe and fingerprint session while viewer attaches to the same Chromium', async () => {
  const { launch } = await import('@mochi.js/core');
  const reservation = await reserveViewerPort(); await reservation.release();
  const markerUrl = `data:text/html,<title>piclaw-viewer-${crypto.randomUUID()}</title>`;
  const session = await launch({ binary: binary!, headless: true, profile: null, args: ['--no-sandbox', `--remote-debugging-port=${reservation.port}`, '--remote-debugging-address=127.0.0.1'], exitIpProbe: 'off' } as any);
  let socket: WebSocket | undefined;
  try {
    const markerPage = await session.newPage(); await markerPage.goto(markerUrl, { waitUntil: 'domcontentloaded', timeout: 3000 });
    const initial = await (await fetch(`http://127.0.0.1:${reservation.port}/json/list`)).json() as any[];
    expect(initial.some(target => target.url === markerUrl)).toBe(true);
    await markerPage.close();
    const page = await session.newPage(); await page.goto('data:text/html,<input id="x">');
    const rows = await (await fetch(`http://127.0.0.1:${reservation.port}/json/list`)).json() as any[];
    const target = rows.find(t => t.type === 'page'); expect(target).toBeTruthy();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject; });
    const result = new Promise<any>(resolve => { socket!.onmessage = event => { const row = JSON.parse(String(event.data)); if (row.id === 1) resolve(row); }; });
    socket.send(JSON.stringify({ id: 1, method: 'Page.startScreencast', params: { format: 'jpeg' } }));
    expect((await result).error).toBeUndefined();
    socket.close();
    expect(await page.evaluate(() => document.querySelector('input') !== null)).toBe(true);
    expect(session.owned).toBe(true);
  } finally { socket?.close(); await session.close(); }
}, 20000);
