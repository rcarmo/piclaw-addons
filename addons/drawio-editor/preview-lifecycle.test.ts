import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { handleRoute } from './index';

async function fixture(readOnly = true, delayedFetch = false) {
  const response = await handleRoute(new Request('http://fixture/drawio/edit.html'), '/drawio/edit.html');
  const source = (await response!.text()).match(/<script>([\s\S]*?)<\/script>/)![1];
  const events = new Map<string, (event?: any) => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const posts: unknown[] = [];
  let timerId = 0;
  const node = () => ({ style: {} as any, textContent: '', hidden: true, setAttribute() {}, classList: { add() {}, remove() {} } });
  const loading = node();
  const frame = { ...node(), src: '', onload: null as null | (() => void), contentWindow: { postMessage: (value: unknown) => posts.push(value) } };
  const nodes: Record<string, any> = { loading, 'editor-frame': frame, 'readonly-lock': node(), 'preview-pages': node() };
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const result = { ok: true, text: async () => '<mxfile/>' };
  const globals: any = {
    URLSearchParams, Array, console,
    location: { search: readOnly ? '?media=1&readonly=1' : '?path=fixture.drawio', hash: '', origin: 'http://fixture' },
    document: { title: '', getElementById: (id: string) => nodes[id] },
    fetch: () => delayedFetch ? pending : Promise.resolve(result),
    setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    addEventListener(name: string, callback: (event?: any) => void) { events.set(name, callback); },
    matchMedia: () => ({ matches: false }),
  };
  globals.window = globals;
  runInNewContext(source, globals);
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  await flush();
  return { globals, frame, loading, timers, posts, events, count: () => timerId, flush, release: () => release(result),
    init: () => events.get('message')!({ data: JSON.stringify({ event: 'init' }), origin: 'http://fixture', source: frame.contentWindow }),
    tick: () => { const [id, timer] = timers.entries().next().value!; timers.delete(id); timer.callback(); },
  };
}

test('read-only missing prototype fails on init with no polling or duplicate retry chains', async () => {
  const f = await fixture();
  expect([...f.timers.values()].map(t => t.delay)).toEqual([15000]);
  f.frame.onload!(); f.frame.onload!();
  expect(f.count()).toBe(1);
  f.init();
  expect(f.loading.textContent).toContain('page navigation is unavailable');
  expect(f.timers.size).toBe(0);
  f.init();
  expect(f.posts).toEqual([]);
  expect(f.count()).toBe(1);
});

test('vendor never ready gets one bounded deadline, not prototype retries', async () => {
  const f = await fixture();
  f.tick();
  expect(f.loading.textContent).toContain('did not become ready');
  expect(f.timers.size).toBe(0);
  f.init();
  expect(f.posts).toEqual([]);
  expect(f.count()).toBe(1);
});

test('only trusted readiness installs the hook and clears the deadline before loading', async () => {
  const f = await fixture();
  f.events.get('message')!({ data: JSON.stringify({ event: 'init' }), origin: 'http://other', source: f.frame.contentWindow });
  expect(f.timers.size).toBe(1);
  expect(f.posts).toEqual([]);
  (f.frame.contentWindow as any).EditorUi = { prototype: { setFileData() {} } };
  f.init();
  expect(f.timers.size).toBe(0);
  expect((f.frame.contentWindow as any).EditorUi.prototype.__piclawReadonlyPagesPatched).toBe(true);
  expect(JSON.parse(f.posts[0] as string)).toMatchObject({ action: 'load', autosave: 0 });
  f.events.get('pagehide')!(); f.init();
  expect(f.posts).toHaveLength(1);
});

test('pagehide clears startup timer, detaches load and ignores late init', async () => {
  const f = await fixture();
  const lateTimer = [...f.timers.values()][0].callback;
  f.events.get('pagehide')!();
  expect(f.timers.size).toBe(0);
  expect(f.frame.onload).toBeNull();
  f.init(); lateTimer();
  expect(f.posts).toEqual([]);
  expect(f.count()).toBe(1);
  expect(f.loading.textContent).toBe('');
});

test('a pending media fetch cannot restart the preview after disposal', async () => {
  const f = await fixture(true, true);
  f.events.get('pagehide')!(); f.release(); await f.flush();
  expect(f.frame.src).toBe('');
  expect(f.count()).toBe(0);
});

test('editable export patch retry is bounded, deduplicated and cancelled on pagehide', async () => {
  const f = await fixture(false);
  f.frame.onload!(); f.frame.onload!();
  expect(f.timers.size).toBe(1);
  expect(f.count()).toBe(1);
  for (let n = 0; n < 205 && f.timers.size; n++) f.tick();
  expect(f.timers.size).toBe(0);
  expect(f.count()).toBe(200);
  const disposed = await fixture(false);
  const lateTimer = [...disposed.timers.values()][0].callback;
  disposed.events.get('pagehide')!(); lateTimer();
  expect(disposed.timers.size).toBe(0);
  expect(disposed.count()).toBe(1);
});
