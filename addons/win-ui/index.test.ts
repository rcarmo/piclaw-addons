import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import registerWinUi, {
  formatDesktopScreenshotSummary,
  formatKillSummary,
  formatMonitorScreenshotSummary,
  formatRegionScreenshotSummary,
  serializeMonitorList,
  serializeWindowList,
  type BitmapPixels,
  type MonitorInfo,
  type WindowInfo,
  writeBitmapToPath,
} from './index.ts';

describe('win-ui helpers', () => {
  test('register is a safe no-op off Windows', () => {
    const tools = new Map<string, unknown>();
    const fakeApi = { registerTool(tool: any) { tools.set(tool.name, tool); } } as any;

    registerWinUi(fakeApi);

    if (process.platform === 'win32') {
      expect(tools.has('win_list_windows')).toBe(true);
      expect(tools.has('win_screenshot')).toBe(true);
      expect(tools.has('win_desktop_screenshot')).toBe(true);
      expect(tools.has('win_list_monitors')).toBe(true);
      expect(tools.has('win_monitor_screenshot')).toBe(true);
      expect(tools.has('win_region_screenshot')).toBe(true);
      expect(tools.has('win_kill')).toBe(true);
    } else {
      expect(tools.size).toBe(0);
    }
  });

  test('serializeWindowList preserves pid in listed window output', () => {
    const windows: WindowInfo[] = [
      {
        handle: 101,
        title: 'Calculator',
        className: 'ApplicationFrameWindow',
        pid: 4242,
        rect: { x: 10, y: 20, w: 300, h: 400 },
      },
    ];

    expect(serializeWindowList(windows)).toEqual([
      {
        handle: 101,
        title: 'Calculator',
        className: 'ApplicationFrameWindow',
        pid: 4242,
        rect: { x: 10, y: 20, w: 300, h: 400 },
      },
    ]);
  });

  test('formatKillSummary uses the requested action verb', () => {
    expect(formatKillSummary([
      { title: 'Edge', handle: 99, pid: 501 },
    ], false)).toBe('Closed "Edge" (handle=99, pid=501)');

    expect(formatKillSummary([
      { title: 'Edge', handle: 99, pid: 501, terminated: true },
    ], true)).toBe('Terminated "Edge" (handle=99, pid=501, killed)');
  });

  test('formatKillSummary calls out failed force termination explicitly', () => {
    expect(formatKillSummary([
      { title: 'Edge', handle: 99, pid: 501, terminated: false },
    ], true)).toBe('Close requested "Edge" (handle=99, pid=501, process termination unavailable)');
  });

  test('serializeMonitorList preserves index, name, and work area', () => {
    const monitors: MonitorInfo[] = [
      {
        index: 2,
        handle: 88,
        deviceName: '\\\\.\\DISPLAY2',
        isPrimary: false,
        rect: { x: -1920, y: 0, w: 1920, h: 1080 },
        workRect: { x: -1920, y: 0, w: 1920, h: 1040 },
      },
    ];

    expect(serializeMonitorList(monitors)).toEqual([
      {
        index: 2,
        handle: 88,
        deviceName: '\\\\.\\DISPLAY2',
        isPrimary: false,
        rect: { x: -1920, y: 0, w: 1920, h: 1080 },
        workRect: { x: -1920, y: 0, w: 1920, h: 1040 },
      },
    ]);
  });

  test('desktop, monitor, and region summaries include origin and dimensions', () => {
    expect(formatDesktopScreenshotSummary({ width: 1920, height: 1080, x: -1920, y: 0 }, 'C:/tmp/desktop.png'))
      .toBe('Captured desktop → C:/tmp/desktop.png (1920x1080, origin=-1920,0)');
    expect(formatMonitorScreenshotSummary({ index: 2, deviceName: '\\\\.\\DISPLAY2' }, { width: 1920, height: 1080, x: -1920, y: 0 }, 'C:/tmp/monitor-2.png'))
      .toBe('Captured monitor 2 (\\\\.\\DISPLAY2) → C:/tmp/monitor-2.png (1920x1080, origin=-1920,0)');
    expect(formatRegionScreenshotSummary({ width: 800, height: 600, x: -400, y: 20 }, 'C:/tmp/region.png'))
      .toBe('Captured region → C:/tmp/region.png (800x600, origin=-400,20)');
  });

  test('writeBitmapToPath writes BMP and PNG from shared bitmap data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'piclaw-win-ui-'));
    const bmpPath = join(dir, 'shot.bmp');
    const pngPath = join(dir, 'shot.png');
    const bitmap: BitmapPixels = {
      width: 1,
      height: 1,
      rowSize: 4,
      pixelData: Buffer.from([0x00, 0x00, 0xff, 0x00]), // one red pixel in BGR + padding
    };

    writeBitmapToPath(bmpPath, bitmap);
    writeBitmapToPath(pngPath, bitmap);

    const bmp = readFileSync(bmpPath);
    const png = readFileSync(pngPath);
    expect(bmp.subarray(0, 2).toString('ascii')).toBe('BM');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
});
