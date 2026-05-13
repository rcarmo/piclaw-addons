/**
 * Windows UI Automation Extension — pure bun:ffi, zero external helpers
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Single-file extension that provides full Windows desktop automation via
 * Bun's FFI layer calling directly into Win32 system DLLs. No PowerShell,
 * no csc.exe, no compiled helpers — only system DLLs, so Windows Defender
 * has nothing to flag.
 *
 * ── Architecture ─────────────────────────────────────────────────────
 *
 *   user32.dll    → Window enumeration (EnumWindows + JSCallback)
 *                 → Mouse input (SetCursorPos, mouse_event)
 *                 → Keyboard input (keybd_event)
 *                 → Window screenshots (PrintWindow — works through lock screen)
 *   gdi32.dll     → Bitmap capture (CreateCompatibleDC, GetDIBits → BMP file)
 *   ole32.dll     → COM initialization (CoInitializeEx, STA)
 *   oleacc.dll    → IAccessible/MSAA tree (AccessibleObjectFromWindow,
 *                   AccessibleChildren — finds ALL UI elements including
 *                   non-HWND controls inside Chrome/Edge, WPF, UWP apps)
 *   oleaut32.dll  → COM cleanup (VariantClear)
 *
 * ── Tools at a glance ────────────────────────────────────────────────
 *
 *   win_list_windows
 *     List all visible top-level windows. Returns title, window class,
 *     process ID, and bounding rectangle for each. Use this first to
 *     discover what's on screen.
 *
 *   win_screenshot  titleMatch="Edge" outPath="shot.bmp"
 *     Capture any window to a 24-bit BMP by title substring. Uses
 *     PrintWindow which renders from the window handle directly —
 *     works even when the desktop session is locked. Good for visual
 *     inspection, dialog detection, and debugging.
 *
 *   win_desktop_screenshot  outPath="desktop.png"
 *     Capture the full interactive virtual desktop across all monitors.
 *     Uses pure GDI BitBlt from the desktop DC and supports negative
 *     virtual-screen origins for multi-monitor layouts.
 *
 *   win_list_monitors
 *     List all attached monitors with index, device name, primary flag,
 *     and monitor/work-area rectangles.
 *
 *   win_monitor_screenshot  monitorIndex=2 outPath="monitor-2.png"
 *     Capture one monitor by index or device name using the same virtual-
 *     screen GDI capture path as desktop capture.
 *
 *   win_region_screenshot  x=0 y=0 width=800 height=600 outPath="region.png"
 *     Capture an arbitrary desktop region, including negative coordinates
 *     on multi-monitor layouts.
 *
 *   win_find_elements  windowTitle="Edge" elementName="Close"
 *     Search for interactive UI elements (buttons, links, tabs, menus)
 *     by name inside any window. Walks the IAccessible/MSAA tree which
 *     sees non-HWND controls — Edge toolbar buttons, VS Code commands,
 *     UWP app controls. Returns name, role, and child count.
 *
 *   win_click  windowTitle="Edge" elementName="Close tab"
 *   win_click  x=640 y=512
 *     Click a named element (found via IAccessible, clicked via
 *     accDoDefaultAction or center-coordinate fallback) or click at
 *     raw screen coordinates. Both work through the lock screen.
 *
 *   win_type  text="hello"
 *   win_type  vk=0x0D  (Enter)
 *   win_type  vk=0x43 ctrl=true  (Ctrl+C)
 *     Send text to the focused window (via SendInput with KEYEVENTF_UNICODE)
 *     key code with optional Ctrl/Alt/Shift modifiers (via keybd_event).
 *
 *   win_tree  windowTitle="Edge" maxDepth=6
 *     Dump the full IAccessible tree for a window — shows every element
 *     with its MSAA role (pushbutton, link, pagetab, etc.), child count,
 *     and name. Use this to discover what elements exist and how they're
 *     named before using win_find_elements or win_click.
 *
 * ── How IAccessible works ────────────────────────────────────────────
 *
 * Unlike UIA (IUIAutomation), which requires COM FindAll/TreeWalker calls
 * that need struct-by-value VARIANT marshalling (impossible from bun:ffi),
 * IAccessible (MSAA) passes VARIANTs by hidden pointer on x64 Windows.
 * This means CFunction can call IAccessible vtable methods directly:
 *
 *   1. oleacc.dll::AccessibleObjectFromWindow(hwnd) → IAccessible* root
 *   2. root->get_accChildCount() → number of children
 *   3. oleacc.dll::AccessibleChildren(root) → array of child IAccessible*
 *   4. child->get_accName(CHILDID_SELF) → element name (BSTR)
 *   5. child->get_accRole(CHILDID_SELF) → role (button, link, tab, etc.)
 *   6. child->accDoDefaultAction() → click/activate the element
 *   7. child->accLocation() → bounding rect for coordinate clicks
 *
 * COM vtable calls work via: read vtable pointer from interface pointer,
 * read function pointer at vtable[index], wrap with CFunction, call.
 *
 * ── IAccessible vtable layout (inherits IDispatch → IUnknown) ────────
 *
 *   0  QueryInterface       (IUnknown)
 *   1  AddRef                (IUnknown)
 *   2  Release               (IUnknown)
 *   3  GetTypeInfoCount      (IDispatch)
 *   4  GetTypeInfo           (IDispatch)
 *   5  GetIDsOfNames         (IDispatch)
 *   6  Invoke                (IDispatch)
 *   7  get_accParent         → IDispatch* parent
 *   8  get_accChildCount     → long* count
 *   9  get_accChild          → IDispatch* child (by VARIANT childId)
 *  10  get_accName           → BSTR* name (by VARIANT childId)
 *  11  get_accValue          → BSTR* value
 *  12  get_accDescription    → BSTR* description
 *  13  get_accRole           → VARIANT* role (by VARIANT childId)
 *  14  get_accState          → VARIANT* state
 *  15  get_accHelp           → BSTR* help
 *  16  get_accHelpTopic      → BSTR* helpFile, long* topicId
 *  17  get_accKeyboardShortcut → BSTR*
 *  18  get_accFocus          → VARIANT*
 *  19  get_accSelection      → VARIANT*
 *  20  get_accDefaultAction  → BSTR* (by VARIANT childId)
 *  21  accSelect             → select/focus (flagsSelect, varChild)
 *  22  accLocation           → long* left, top, width, height (by VARIANT)
 *  23  accNavigate           → VARIANT* (navDir, varStart)
 *  24  accHitTest            → VARIANT* (left, top)
 *  25  accDoDefaultAction    → invoke/click (by VARIANT childId)
 *
 * ── MSAA role constants ──────────────────────────────────────────────
 *
 *   9=client  10=window  13=document  14=alert  15=pane  16=grouping
 *   20=menubar  21=menuitem  22=list  23=listitem  25=outline
 *   33=scrollbar  34=statusbar  37=toolbar  40=titlebar  42=edit
 *   43=pushbutton  44=radiobutton  45=text  46=indicator  47=spinbutton
 *   58=link  60=pagetab  61=pagetablist  62=dialog  64=table
 *
 * ── Screenshot approach ──────────────────────────────────────────────
 *
 * Uses PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2) which renders the
 * window's content from its window handle directly — bypasses the lock
 * screen and DWM compositing. Works even when the desktop session is
 * locked. The bitmap is extracted via GetDIBits and saved as 24-bit BMP.
 *
 * ── Limitations ──────────────────────────────────────────────────────
 *
 * - Bitmap extraction still uses a 24-bit BMP pipeline, with optional in-process PNG conversion
 * - IAccessible tree may be shallower than UIA for some modern apps
 * - For web content inside Edge, prefer CDP (cdp_browser tool) which has
 *   full DOM access. IAccessible sees the accessibility layer, not the DOM.
 *
 * ── Platform gate ────────────────────────────────────────────────────
 *
 * This extension only loads on Windows. On other platforms, the default
 * export is a no-op. Safe to include in cross-platform piclaw installs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "fs";

function registerToolStatusHintProvider(provider: { id: string; buildHints: (context: { toolName: string; args: unknown }) => unknown }): void {
  const fn = (globalThis as any).__piclaw_registerToolStatusHintProvider;
  if (typeof fn === "function") fn(provider);
}

function debugSuppressedError(_log: unknown, message: string, error: unknown, details?: Record<string, unknown>): void {
  if (process.env.PICLAW_DEBUG_WIN_UI !== "1") return;
  console.debug(`[win-ui] ${message}`, { error, ...details });
}

const WINDOWS_UI_STATUS_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="14" rx="2"></rect><path d="M8 20h8"></path><path d="M12 18v2"></path><g fill="currentColor" stroke="none"><rect x="8.5" y="7.5" width="3" height="3" rx="0.5"></rect><rect x="12.5" y="7.5" width="3" height="3" rx="0.5"></rect><rect x="8.5" y="11.5" width="3" height="3" rx="0.5"></rect><rect x="12.5" y="11.5" width="3" height="3" rx="0.5"></rect></g></svg>`;
const log = "addons.win-ui";

function readTrimmedString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

registerToolStatusHintProvider({
  id: "win_ui",
  buildHints: ({ toolName, args }) => {
    if (!toolName.startsWith("win_")) return null;
    const record = args && typeof args === "object" ? args as Record<string, unknown> : null;
    const label = readTrimmedString(
      record?.windowTitle,
      record?.titleMatch,
      record?.deviceName,
      typeof record?.monitorIndex === "number" ? `monitor ${record.monitorIndex}` : null,
      record?.elementName,
      (record?.x !== undefined && record?.y !== undefined && record?.width !== undefined && record?.height !== undefined)
        ? `${record.x},${record.y} ${record.width}x${record.height}`
        : null,
      record?.outPath,
      (record?.x !== undefined && record?.y !== undefined) ? `${record.x},${record.y}` : null,
    );
    if (!label) return null;
    return {
      key: "win_ui",
      icon_svg: WINDOWS_UI_STATUS_ICON_SVG,
      label,
      title: `Windows UI target • ${label}`,
      kind: "service",
    };
  },
});

// ── DLL bindings (lazy-loaded) ──────────────────────────────────────────
// All DLL loads and COM init happen inside ensureInit(), called once from
// register(). On non-Windows platforms, register() returns immediately.
// bun:ffi is require()'d at runtime to avoid import errors on Linux/macOS.

let _init = false;
let user32: any, gdi32: any, ole32: any, oleacc: any, oleaut32: any, kernel32: any;
let _FFIType: any, _CFunction: any, _JSCallback: any, _ptr: any, _toArrayBuffer: any;

// Constants (defined after init but used by helpers)
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const KEYEVENTF_KEYUP = 0x0002;
const PW_RENDERFULLCONTENT = 2;
const OBJID_CLIENT = 0xFFFFFFFC;
const SRCCOPY = 0x00CC0020;
const CAPTUREBLT = 0x40000000;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const MONITORINFOF_PRIMARY = 0x00000001;

function ensureInit() {
  if (_init) return;
  _init = true;
  const ffi = require("bun:ffi");
  _FFIType = ffi.FFIType; _CFunction = ffi.CFunction; _JSCallback = ffi.JSCallback;
  _ptr = ffi.ptr; _toArrayBuffer = ffi.toArrayBuffer;
  const F = _FFIType;

  ole32 = ffi.dlopen("ole32.dll", {
    CoInitializeEx: { args: [F.ptr, F.u32], returns: F.i32 },
  });
  oleacc = ffi.dlopen("oleacc.dll", {
    AccessibleObjectFromWindow: { args: [F.ptr, F.u32, F.ptr, F.ptr], returns: F.i32 },
    AccessibleChildren: { args: [F.ptr, F.i32, F.i32, F.ptr, F.ptr], returns: F.i32 },
  });
  oleaut32 = ffi.dlopen("oleaut32.dll", {
    VariantClear: { args: [F.ptr], returns: F.i32 },
  });
  user32 = ffi.dlopen("user32.dll", {
    EnumWindows: { args: [F.ptr, F.ptr], returns: F.i32 },
    EnumDisplayMonitors: { args: [F.ptr, F.ptr, F.ptr, F.ptr], returns: F.i32 },
    IsWindowVisible: { args: [F.ptr], returns: F.i32 },
    GetWindowTextW: { args: [F.ptr, F.ptr, F.i32], returns: F.i32 },
    GetWindowTextLengthW: { args: [F.ptr], returns: F.i32 },
    GetClassNameW: { args: [F.ptr, F.ptr, F.i32], returns: F.i32 },
    FindWindowW: { args: [F.ptr, F.ptr], returns: F.ptr },
    GetWindowRect: { args: [F.ptr, F.ptr], returns: F.i32 },
    GetDC: { args: [F.ptr], returns: F.ptr },
    ReleaseDC: { args: [F.ptr, F.ptr], returns: F.i32 },
    PrintWindow: { args: [F.ptr, F.ptr, F.u32], returns: F.i32 },
    SetCursorPos: { args: [F.i32, F.i32], returns: F.i32 },
    mouse_event: { args: [F.i32, F.i32, F.i32, F.i32, F.ptr], returns: F.void },
    keybd_event: { args: [F.u8, F.u8, F.i32, F.ptr], returns: F.void },
    GetSystemMetrics: { args: [F.i32], returns: F.i32 },
    SetForegroundWindow: { args: [F.ptr], returns: F.i32 },
    SendInput: { args: [F.u32, F.ptr, F.i32], returns: F.u32 },
    PostMessageW: { args: [F.ptr, F.u32, F.ptr, F.ptr], returns: F.i32 },
    GetWindowThreadProcessId: { args: [F.ptr, F.ptr], returns: F.u32 },
    GetMonitorInfoW: { args: [F.ptr, F.ptr], returns: F.i32 },
  });
  kernel32 = ffi.dlopen("kernel32.dll", {
    OpenProcess: { args: [F.u32, F.i32, F.u32], returns: F.ptr },
    TerminateProcess: { args: [F.ptr, F.u32], returns: F.i32 },
    CloseHandle: { args: [F.ptr], returns: F.i32 },
  });
  gdi32 = ffi.dlopen("gdi32.dll", {
    CreateCompatibleDC: { args: [F.ptr], returns: F.ptr },
    CreateCompatibleBitmap: { args: [F.ptr, F.i32, F.i32], returns: F.ptr },
    SelectObject: { args: [F.ptr, F.ptr], returns: F.ptr },
    BitBlt: { args: [F.ptr, F.i32, F.i32, F.i32, F.i32, F.ptr, F.i32, F.i32, F.u32], returns: F.i32 },
    DeleteDC: { args: [F.ptr], returns: F.i32 },
    DeleteObject: { args: [F.ptr], returns: F.i32 },
    GetDIBits: { args: [F.ptr, F.ptr, F.u32, F.u32, F.ptr, F.ptr, F.u32], returns: F.i32 },
  });

  // Initialize COM in Single-Threaded Apartment mode (required for IAccessible)
  ole32.symbols.CoInitializeEx(null, 2);
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Encode a GUID string into a 16-byte binary buffer (CLSID/IID format) */
function guidBuf(g: string): Buffer {
  const h = g.replace(/[{}-]/g, "");
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.substring(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.substring(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.substring(12, 16), 16), 6);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(h.substring(16 + i * 2, 18 + i * 2), 16);
  return b;
}

const IID_IAccessible = guidBuf("618736e0-3c3d-11cf-810c-00aa00389b71");

/**
 * Read a COM vtable entry: dereference interface pointer → vtable pointer,
 * then read the function pointer at vtable[index * 8] (x64 pointers are 8 bytes).
 */
function vte(p: number, i: number): number {
  const vt = Number(new DataView(_toArrayBuffer(p, 0, 8)).getBigUint64(0, true));
  return Number(new DataView(_toArrayBuffer(vt, i * 8, 8)).getBigUint64(0, true));
}

/** Read a COM BSTR (length-prefixed UTF-16 string) from a pointer */
function readBSTR(p: number): string {
  if (!p) return "";
  const l = new DataView(_toArrayBuffer(p - 4, 0, 4)).getUint32(0, true);
  if (!l || l > 10000) return "";
  return Buffer.from(_toArrayBuffer(p, 0, l)).toString("utf16le");
}

/** Read a null-terminated UTF-16 (wide) string from a buffer */
function readWide(buf: Buffer, max: number): string {
  const chars: string[] = [];
  for (let i = 0; i < max; i++) {
    const c = buf.readUInt16LE(i * 2);
    if (c === 0) break;
    chars.push(String.fromCharCode(c));
  }
  return chars.join("");
}

const ROLE_NAMES: Record<number, string> = {
  9: "client", 10: "window", 13: "document", 14: "alert", 15: "pane",
  16: "grouping", 20: "menubar", 21: "menuitem", 22: "list", 23: "listitem",
  25: "outline", 33: "scrollbar", 34: "statusbar", 37: "toolbar", 40: "titlebar",
  42: "edit", 43: "pushbutton", 44: "radiobutton", 45: "text", 46: "indicator",
  47: "spinbutton", 58: "link", 60: "pagetab", 61: "pagetablist", 62: "dialog",
  64: "table", 65: "row", 66: "cell", 68: "chart", 69: "graphic",
};

// ── IAccessible helpers ─────────────────────────────────────────────────
// These call IAccessible COM methods via CFunction wrapping vtable entries.
// On x64 Windows, VARIANT args (>8 bytes) are passed by hidden pointer,
// so CFunction with _FFIType.ptr works correctly for VARIANT parameters.

/** Get name, role, and child count for an IAccessible element (CHILDID_SELF) */
function accGetInfo(p: number): { name: string; role: string; roleId: number; children: number } {
  const cv = Buffer.alloc(24);
  cv.writeUInt16LE(3, 0); // VT_I4, CHILDID_SELF=0

  const pN = Buffer.alloc(8);
  new _CFunction({ ptr: vte(p, 10), args: [_FFIType.ptr, _FFIType.ptr, _FFIType.ptr], returns: _FFIType.i32 })(p, _ptr(cv), _ptr(pN));
  const name = readBSTR(Number(pN.readBigUInt64LE(0)));

  const vR = Buffer.alloc(24);
  new _CFunction({ ptr: vte(p, 13), args: [_FFIType.ptr, _FFIType.ptr, _FFIType.ptr], returns: _FFIType.i32 })(p, _ptr(cv), _ptr(vR));
  const r = vR.readUInt16LE(0) === 3 ? vR.readInt32LE(8) : -1;
  oleaut32.symbols.VariantClear(_ptr(vR));

  const cc = Buffer.alloc(4);
  new _CFunction({ ptr: vte(p, 8), args: [_FFIType.ptr, _FFIType.ptr], returns: _FFIType.i32 })(p, _ptr(cc));

  return { name, role: ROLE_NAMES[r] || String(r), roleId: r, children: cc.readInt32LE(0) };
}

/** Get child IAccessible pointers via oleacc.dll::AccessibleChildren */
function accGetChildren(p: number, max = 30): number[] {
  const info = accGetInfo(p);
  if (info.children <= 0) return [];
  const count = Math.min(info.children, max);
  const varArr = Buffer.alloc(24 * count);
  const ob = Buffer.alloc(4);
  oleacc.symbols.AccessibleChildren(p, 0, count, _ptr(varArr), _ptr(ob));
  const obtained = ob.readInt32LE(0);
  const ptrs: number[] = [];
  for (let i = 0; i < obtained; i++) {
    const off = i * 24;
    const vt = varArr.readUInt16LE(off);
    if (vt === 9 || vt === 13) {
      const cp = Number(varArr.readBigUInt64LE(off + 8));
      if (cp) ptrs.push(cp);
    }
  }
  return ptrs;
}

/** Invoke the default action (click/activate) on an IAccessible element (vtable 25) */
function accDoDefaultAction(p: number): boolean {
  const cv = Buffer.alloc(24);
  cv.writeUInt16LE(3, 0);
  try {
    const hr = new _CFunction({ ptr: vte(p, 25), args: [_FFIType.ptr, _FFIType.ptr], returns: _FFIType.i32 })(p, _ptr(cv));
    return hr >= 0;
  } catch (error) {
    debugSuppressedError(log, "Failed to invoke IAccessible default action.", error, {
      operation: "win_ui.acc_do_default_action",
      pointer: p,
    });
    return false;
  }
}

/** Release a COM interface (IUnknown::Release, vtable 2) */
function accRelease(p: number) {
  try {
    new _CFunction({ ptr: vte(p, 2), args: [_FFIType.ptr], returns: _FFIType.i32 })(p);
  } catch (error) {
    debugSuppressedError(log, "Failed to release IAccessible pointer.", error, {
      operation: "win_ui.acc_release",
      pointer: p,
    });
    return;
  }
}

interface AccElement {
  name: string;
  role: string;
  children: number;
  ptr: number;
}

/**
 * Find named elements inside a window by walking the IAccessible tree.
 * Uses AccessibleObjectFromWindow to get the root, then recursively
 * walks children via AccessibleChildren, matching names case-insensitively.
 */
function accFindElements(hwnd: number | any, nameMatch: string, maxResults = 30, maxDepth = 8): AccElement[] {
  const ppAcc = Buffer.alloc(8);
  const hr = oleacc.symbols.AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, _ptr(IID_IAccessible), _ptr(ppAcc));
  if (hr < 0) return [];
  const pAcc = Number(ppAcc.readBigUInt64LE(0));
  if (!pAcc) return [];

  const results: AccElement[] = [];
  const lowerMatch = nameMatch.toLowerCase();

  function walk(p: number, depth: number) {
    if (depth > maxDepth || results.length >= maxResults) return;
    const info = accGetInfo(p);
    if (info.name && info.name.toLowerCase().includes(lowerMatch)) {
      results.push({ name: info.name, role: info.role, children: info.children, ptr: p });
    }
    const kids = accGetChildren(p);
    for (const kid of kids) walk(kid, depth + 1);
  }

  walk(pAcc, 0);
  return results;
}

// ── Window helpers ──────────────────────────────────────────────────────
// Uses EnumWindows with JSCallback (Bun's FFI callback mechanism) to
// collect all visible top-level windows with their properties.

/** Enumerate all visible top-level windows with title, class, and bounding rect */

export interface WindowInfo {
  handle: number;
  title: string;
  className: string;
  pid: number;
  rect: { x: number; y: number; w: number; h: number };
}

export interface KillSummaryItem {
  title: string;
  handle: number;
  pid?: number;
  terminated?: boolean;
}

export interface BitmapPixels {
  width: number;
  height: number;
  rowSize: number;
  pixelData: Buffer;
}

export interface MonitorInfo {
  index: number;
  handle: number;
  deviceName: string;
  isPrimary: boolean;
  rect: { x: number; y: number; w: number; h: number };
  workRect: { x: number; y: number; w: number; h: number };
}

export function serializeWindowList(wins: WindowInfo[]): Array<Pick<WindowInfo, "title" | "className" | "rect" | "handle" | "pid">> {
  return wins.map(w => ({
    title: w.title,
    className: w.className,
    rect: w.rect,
    handle: w.handle,
    pid: w.pid,
  }));
}

export function formatKillSummary(results: KillSummaryItem[], force: boolean): string {
  return results
    .map(r => {
      const verb = !force ? "Closed" : r.terminated ? "Terminated" : "Close requested";
      const suffix = force && r.terminated === false
        ? ", process termination unavailable"
        : force && r.terminated
          ? ", killed"
          : "";
      return `${verb} "${r.title}" (handle=${r.handle}${r.pid ? `, pid=${r.pid}` : ""}${suffix})`;
    })
    .join("\n");
}

export function serializeMonitorList(monitors: MonitorInfo[]): Array<Pick<MonitorInfo, "index" | "deviceName" | "isPrimary" | "rect" | "workRect" | "handle">> {
  return monitors.map(m => ({
    index: m.index,
    deviceName: m.deviceName,
    isPrimary: m.isPrimary,
    rect: m.rect,
    workRect: m.workRect,
    handle: m.handle,
  }));
}

export function formatDesktopScreenshotSummary(result: { width: number; height: number; x: number; y: number }, outPath: string): string {
  return `Captured desktop → ${outPath} (${result.width}x${result.height}, origin=${result.x},${result.y})`;
}

export function formatMonitorScreenshotSummary(monitor: Pick<MonitorInfo, "index" | "deviceName">, result: { width: number; height: number; x: number; y: number }, outPath: string): string {
  return `Captured monitor ${monitor.index} (${monitor.deviceName}) → ${outPath} (${result.width}x${result.height}, origin=${result.x},${result.y})`;
}

export function formatRegionScreenshotSummary(result: { width: number; height: number; x: number; y: number }, outPath: string): string {
  return `Captured region → ${outPath} (${result.width}x${result.height}, origin=${result.x},${result.y})`;
}

function listWindows(): WindowInfo[] {
  const results: WindowInfo[] = [];
  const titleBuf = Buffer.alloc(512);
  const clsBuf = Buffer.alloc(512);

  const cb = new _JSCallback(
    (hwnd: any) => {
      const h = Number(hwnd);
      if (!user32.symbols.IsWindowVisible(h as any)) return 1;
      const len = user32.symbols.GetWindowTextLengthW(h as any) as number;
      if (len <= 0) return 1;

      titleBuf.fill(0);
      user32.symbols.GetWindowTextW(h as any, _ptr(titleBuf), 255);
      const title = readWide(titleBuf, 255);

      clsBuf.fill(0);
      user32.symbols.GetClassNameW(h as any, _ptr(clsBuf), 255);
      const className = readWide(clsBuf, 255);

      const rectBuf = Buffer.alloc(16);
      user32.symbols.GetWindowRect(h as any, _ptr(rectBuf));
      const rect = {
        x: rectBuf.readInt32LE(0), y: rectBuf.readInt32LE(4),
        w: rectBuf.readInt32LE(8) - rectBuf.readInt32LE(0),
        h: rectBuf.readInt32LE(12) - rectBuf.readInt32LE(4),
      };

      const pidBuf = Buffer.alloc(4);
      user32.symbols.GetWindowThreadProcessId(h as any, _ptr(pidBuf));
      const pid = pidBuf.readUInt32LE(0);

      results.push({ handle: h, title, className, pid, rect });
      return 1;
    },
    { args: [_FFIType.ptr, _FFIType.ptr], returns: _FFIType.i32 },
  );
  user32.symbols.EnumWindows(cb.ptr, null);
  cb.close();
  return results;
}

function listMonitors(): MonitorInfo[] {
  const results: MonitorInfo[] = [];

  const cb = new _JSCallback(
    (hMonitor: any) => {
      const handle = Number(hMonitor);
      const infoBuf = Buffer.alloc(104);
      infoBuf.writeUInt32LE(104, 0);
      const ok = Number(user32.symbols.GetMonitorInfoW(hMonitor, _ptr(infoBuf)));
      if (!ok) return 1;

      const rect = {
        x: infoBuf.readInt32LE(4),
        y: infoBuf.readInt32LE(8),
        w: infoBuf.readInt32LE(12) - infoBuf.readInt32LE(4),
        h: infoBuf.readInt32LE(16) - infoBuf.readInt32LE(8),
      };
      const workRect = {
        x: infoBuf.readInt32LE(20),
        y: infoBuf.readInt32LE(24),
        w: infoBuf.readInt32LE(28) - infoBuf.readInt32LE(20),
        h: infoBuf.readInt32LE(32) - infoBuf.readInt32LE(24),
      };
      const flags = infoBuf.readUInt32LE(36);
      const deviceName = readWide(infoBuf.subarray(40, 104), 32);

      results.push({
        index: results.length + 1,
        handle,
        deviceName,
        isPrimary: (flags & MONITORINFOF_PRIMARY) !== 0,
        rect,
        workRect,
      });
      return 1;
    },
    { args: [_FFIType.ptr, _FFIType.ptr, _FFIType.ptr, _FFIType.ptr], returns: _FFIType.i32 },
  );
  user32.symbols.EnumDisplayMonitors(null, null, cb.ptr, null);
  cb.close();
  return results;
}

/**
 * Capture a window to a 24-bit BMP file using PrintWindow.
 * PrintWindow with PW_RENDERFULLCONTENT=2 renders directly from the
 * window handle — bypasses lock screen and DWM. The bitmap is extracted
 * via GetDIBits (top-down, BGR order) and written as a standard BMP.
 */
function extractBitmapPixels(dc: any, bitmap: any, width: number, height: number): BitmapPixels | null {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelData = Buffer.alloc(rowSize * height);
  const bmiHeader = Buffer.alloc(40);
  bmiHeader.writeUInt32LE(40, 0);
  bmiHeader.writeInt32LE(width, 4);
  bmiHeader.writeInt32LE(-height, 8);
  bmiHeader.writeUInt16LE(1, 12);
  bmiHeader.writeUInt16LE(24, 14);
  const scanlines = Number(gdi32.symbols.GetDIBits(dc, bitmap, 0, height, _ptr(pixelData), _ptr(bmiHeader), 0));
  if (scanlines <= 0) return null;
  return { width, height, rowSize, pixelData };
}

export function writeBitmapToPath(outPath: string, bitmap: BitmapPixels): void {
  const { width, height, rowSize, pixelData } = bitmap;
  const pixelDataSize = pixelData.length;
  const fileSize = 14 + 40 + pixelDataSize;
  const bmp = Buffer.alloc(fileSize);
  bmp.write("BM", 0);
  bmp.writeUInt32LE(fileSize, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(-height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(pixelDataSize, 34);
  pixelData.copy(bmp, 54);

  if (!outPath.toLowerCase().endsWith(".png")) {
    writeFileSync(outPath, bmp);
    return;
  }

  const { deflateSync } = require("node:zlib");
  const pngRowSize = 1 + width * 3;
  const rawPng = Buffer.alloc(pngRowSize * height);
  for (let y = 0; y < height; y++) {
    const srcOff = y * rowSize;
    const dstOff = y * pngRowSize;
    rawPng[dstOff] = 0;
    for (let x = 0; x < width; x++) {
      rawPng[dstOff + 1 + x * 3] = pixelData[srcOff + x * 3 + 2];
      rawPng[dstOff + 1 + x * 3 + 1] = pixelData[srcOff + x * 3 + 1];
      rawPng[dstOff + 1 + x * 3 + 2] = pixelData[srcOff + x * 3];
    }
  }
  const compressed = deflateSync(rawPng);
  const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
  writeFileSync(outPath, png);
}

function captureWindow(hwnd: number, outPath: string): { ok: boolean; width: number; height: number } {
  const rectBuf = Buffer.alloc(16);
  user32.symbols.GetWindowRect(hwnd as any, _ptr(rectBuf));
  const w = rectBuf.readInt32LE(8) - rectBuf.readInt32LE(0);
  const h = rectBuf.readInt32LE(12) - rectBuf.readInt32LE(4);
  if (w <= 0 || h <= 0) return { ok: false, width: 0, height: 0 };

  const screenDC = user32.symbols.GetDC(null);
  const memDC = gdi32.symbols.CreateCompatibleDC(screenDC);
  const bitmap = gdi32.symbols.CreateCompatibleBitmap(screenDC, w, h);
  const oldBitmap = gdi32.symbols.SelectObject(memDC, bitmap);
  user32.symbols.PrintWindow(hwnd as any, memDC, PW_RENDERFULLCONTENT);
  const bitmapPixels = extractBitmapPixels(memDC, bitmap, w, h);

  gdi32.symbols.SelectObject(memDC, oldBitmap);
  gdi32.symbols.DeleteObject(bitmap);
  gdi32.symbols.DeleteDC(memDC);
  user32.symbols.ReleaseDC(null, screenDC);

  if (!bitmapPixels) return { ok: false, width: 0, height: 0 };
  writeBitmapToPath(outPath, bitmapPixels);
  return { ok: true, width: w, height: h };
}

function captureScreenRegion(outPath: string, x: number, y: number, width: number, height: number): { ok: boolean; width: number; height: number; x: number; y: number } {
  if (width <= 0 || height <= 0) return { ok: false, width: 0, height: 0, x, y };

  const screenDC = user32.symbols.GetDC(null);
  const memDC = gdi32.symbols.CreateCompatibleDC(screenDC);
  const bitmap = gdi32.symbols.CreateCompatibleBitmap(screenDC, width, height);
  const oldBitmap = gdi32.symbols.SelectObject(memDC, bitmap);
  const blitOk = Number(gdi32.symbols.BitBlt(memDC, 0, 0, width, height, screenDC, x, y, SRCCOPY | CAPTUREBLT));
  const bitmapPixels = blitOk ? extractBitmapPixels(memDC, bitmap, width, height) : null;

  gdi32.symbols.SelectObject(memDC, oldBitmap);
  gdi32.symbols.DeleteObject(bitmap);
  gdi32.symbols.DeleteDC(memDC);
  user32.symbols.ReleaseDC(null, screenDC);

  if (!bitmapPixels) return { ok: false, width: 0, height: 0, x, y };
  writeBitmapToPath(outPath, bitmapPixels);
  return { ok: true, width, height, x, y };
}

function captureDesktop(outPath: string): { ok: boolean; width: number; height: number; x: number; y: number } {
  const x = Number(user32.symbols.GetSystemMetrics(SM_XVIRTUALSCREEN));
  const y = Number(user32.symbols.GetSystemMetrics(SM_YVIRTUALSCREEN));
  const width = Number(user32.symbols.GetSystemMetrics(SM_CXVIRTUALSCREEN));
  const height = Number(user32.symbols.GetSystemMetrics(SM_CYVIRTUALSCREEN));
  return captureScreenRegion(outPath, x, y, width, height);
}

function captureMonitor(outPath: string, monitor: MonitorInfo): { ok: boolean; width: number; height: number; x: number; y: number } {
  return captureScreenRegion(outPath, monitor.rect.x, monitor.rect.y, monitor.rect.w, monitor.rect.h);
}

// ── Kill window / process ───────────────────────────────────────────────
// WM_CLOSE = 0x0010 — asks window to close gracefully
// If force=true, gets the owning PID via GetWindowThreadProcessId,
// then OpenProcess + TerminateProcess to kill it immediately.

const WM_CLOSE = 0x0010;
const PROCESS_TERMINATE = 0x0001;

function killWindow(hwnd: number, force: boolean): { closed: boolean; pid?: number; terminated?: boolean } {
  // Try graceful WM_CLOSE first
  user32.symbols.PostMessageW(hwnd as any, WM_CLOSE, null, null);
  if (!force) return { closed: true };

  // Get process ID from window handle
  const pidBuf = Buffer.alloc(4);
  user32.symbols.GetWindowThreadProcessId(hwnd as any, _ptr(pidBuf));
  const pid = pidBuf.readUInt32LE(0);
  if (!pid) return { closed: true, pid: 0, terminated: false };

  // Forcefully terminate the process
  const hProc = kernel32.symbols.OpenProcess(PROCESS_TERMINATE, 0, pid);
  if (!hProc || Number(hProc) === 0) return { closed: true, pid, terminated: false };
  const ok = kernel32.symbols.TerminateProcess(hProc, 1);
  kernel32.symbols.CloseHandle(hProc);
  return { closed: true, pid, terminated: !!ok };
}

// ── Extension registration ──────────────────────────────────────────────

export default function register(pi: ExtensionAPI) {
  // Platform gate: skip on non-Windows (no Win32 DLLs available)
  if (process.platform !== "win32") return;
  ensureInit();
  pi.registerTool({
    name: "win_list_windows",
    label: "List Windows",
    description: "Enumerate visible windows with titles, class names, PIDs, and bounding rectangles.",
    promptSnippet: "win_list_windows: list visible top-level windows and their bounds to discover Windows UI targets.",
    parameters: Type.Object({}),
    async execute() {
      const wins = listWindows();
      return {
        content: [{ type: "text", text: JSON.stringify(serializeWindowList(wins), null, 2) }],
        details: { count: wins.length },
      };
    },
  });

  pi.registerTool({
    name: "win_screenshot",
    label: "Window Screenshot",
    description: "Capture a window to a BMP file by title substring. Works through the lock screen via PrintWindow. Use .png extension for automatic PNG conversion.",
    promptSnippet: "win_screenshot: capture a window by title substring to a BMP or PNG file.",
    parameters: Type.Object({
      titleMatch: Type.String({ description: "Window title substring to match" }),
      outPath: Type.String({ description: "Output file path (.bmp or .png)" }),
    }),
    async execute(_id, params) {
      const wins = listWindows();
      const match = wins.find(w => w.title.toLowerCase().includes(params.titleMatch.toLowerCase()));
      if (!match) return { content: [{ type: "text", text: `No window matching "${params.titleMatch}". Available: ${wins.map(w => w.title).join(", ")}` }] };
      const result = captureWindow(match.handle, params.outPath);
      if (!result.ok) return { content: [{ type: "text", text: `Window "${match.title}" could not be captured.` }] };
      return { content: [{ type: "text", text: `Captured "${match.title}" → ${params.outPath} (${result.width}x${result.height})` }], details: { outPath: params.outPath, width: result.width, height: result.height } };
    },
  });

  pi.registerTool({
    name: "win_desktop_screenshot",
    label: "Desktop Screenshot",
    description: "Capture the full interactive virtual desktop across all monitors to a BMP or PNG file using pure Win32 GDI.",
    promptSnippet: "win_desktop_screenshot: capture the full Windows desktop across all monitors to a BMP or PNG file.",
    parameters: Type.Object({
      outPath: Type.String({ description: "Output file path (.bmp or .png)" }),
    }),
    async execute(_id, params) {
      const result = captureDesktop(params.outPath);
      if (!result.ok) return { content: [{ type: "text", text: "Desktop capture failed. Ensure an interactive Windows desktop session is available." }] };
      return {
        content: [{ type: "text", text: formatDesktopScreenshotSummary(result, params.outPath) }],
        details: { outPath: params.outPath, width: result.width, height: result.height, x: result.x, y: result.y },
      };
    },
  });

  pi.registerTool({
    name: "win_list_monitors",
    label: "List Monitors",
    description: "Enumerate attached monitors with index, device name, primary flag, and monitor/work-area rectangles.",
    promptSnippet: "win_list_monitors: list attached Windows monitors and their geometry.",
    parameters: Type.Object({}),
    async execute() {
      const monitors = listMonitors();
      return {
        content: [{ type: "text", text: JSON.stringify(serializeMonitorList(monitors), null, 2) }],
        details: { count: monitors.length },
      };
    },
  });

  pi.registerTool({
    name: "win_monitor_screenshot",
    label: "Monitor Screenshot",
    description: "Capture one monitor by index or device name to a BMP or PNG file using pure Win32 GDI.",
    promptSnippet: "win_monitor_screenshot: capture one monitor by index or device name to a BMP or PNG file.",
    parameters: Type.Object({
      outPath: Type.String({ description: "Output file path (.bmp or .png)" }),
      monitorIndex: Type.Optional(Type.Number({ description: "1-based monitor index from win_list_monitors" })),
      deviceName: Type.Optional(Type.String({ description: "Monitor device name from win_list_monitors, e.g. \\\\.\\DISPLAY2" })),
    }),
    async execute(_id, params) {
      const monitors = listMonitors();
      const monitor = typeof params.monitorIndex === "number"
        ? monitors.find(m => m.index === params.monitorIndex)
        : (typeof params.deviceName === "string" && params.deviceName.trim())
          ? monitors.find(m => m.deviceName.toLowerCase() === params.deviceName.toLowerCase())
          : null;
      if (!monitor) {
        return {
          content: [{ type: "text", text: "No monitor matched the provided monitorIndex/deviceName. Use win_list_monitors first." }],
          details: { available: serializeMonitorList(monitors) },
        };
      }
      const result = captureMonitor(params.outPath, monitor);
      if (!result.ok) return { content: [{ type: "text", text: `Monitor ${monitor.index} could not be captured.` }] };
      return {
        content: [{ type: "text", text: formatMonitorScreenshotSummary(monitor, result, params.outPath) }],
        details: { outPath: params.outPath, width: result.width, height: result.height, x: result.x, y: result.y, monitorIndex: monitor.index, deviceName: monitor.deviceName },
      };
    },
  });

  pi.registerTool({
    name: "win_region_screenshot",
    label: "Region Screenshot",
    description: "Capture an arbitrary desktop region to a BMP or PNG file using pure Win32 GDI. Supports negative coordinates on multi-monitor layouts.",
    promptSnippet: "win_region_screenshot: capture a rectangular Windows desktop region to a BMP or PNG file.",
    parameters: Type.Object({
      x: Type.Number({ description: "Virtual-screen X coordinate" }),
      y: Type.Number({ description: "Virtual-screen Y coordinate" }),
      width: Type.Number({ description: "Region width in pixels" }),
      height: Type.Number({ description: "Region height in pixels" }),
      outPath: Type.String({ description: "Output file path (.bmp or .png)" }),
    }),
    async execute(_id, params) {
      const result = captureScreenRegion(params.outPath, params.x, params.y, params.width, params.height);
      if (!result.ok) return { content: [{ type: "text", text: "Region capture failed. Ensure the requested width/height are positive and an interactive Windows desktop session is available." }] };
      return {
        content: [{ type: "text", text: formatRegionScreenshotSummary(result, params.outPath) }],
        details: { outPath: params.outPath, width: result.width, height: result.height, x: result.x, y: result.y },
      };
    },
  });

  pi.registerTool({
    name: "win_find_elements",
    label: "Find UI Elements",
    description: "Find interactive UI elements by name inside any window. Uses IAccessible (MSAA) — sees non-HWND controls like buttons, tabs, links inside Edge, VS Code, etc. No PowerShell needed.",
    promptSnippet: "win_find_elements: search a Windows accessibility tree for UI elements by window title and element name.",
    parameters: Type.Object({
      windowTitle: Type.String({ description: "Window title substring" }),
      elementName: Type.String({ description: "Element name pattern to search for (case-insensitive)" }),
      maxDepth: Type.Optional(Type.Number({ description: "Max tree depth (default 8)" })),
    }),
    async execute(_id, params) {
      const wins = listWindows();
      const win = wins.find(w => w.title.toLowerCase().includes(params.windowTitle.toLowerCase()));
      if (!win) return { content: [{ type: "text", text: `No window matching "${params.windowTitle}".` }] };
      const elements = accFindElements(win.handle, params.elementName, 30, params.maxDepth ?? 8);
      if (elements.length === 0) return { content: [{ type: "text", text: `No elements matching "${params.elementName}" in "${win.title}".` }] };
      const summary = elements.map(e => ({ name: e.name, role: e.role, children: e.children }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], details: { count: elements.length } };
    },
  });

  pi.registerTool({
    name: "win_click",
    label: "Click",
    description: "Click at screen coordinates, or find a UI element by name in a window and click its center.",
    promptSnippet: "win_click: click Windows UI by coordinates or by locating an element in a window.",
    parameters: Type.Object({
      x: Type.Optional(Type.Number({ description: "Screen X coordinate" })),
      y: Type.Optional(Type.Number({ description: "Screen Y coordinate" })),
      windowTitle: Type.Optional(Type.String({ description: "Window title to search in" })),
      elementName: Type.Optional(Type.String({ description: "Element name to click" })),
    }),
    async execute(_id, params) {
      if (params.x !== undefined && params.y !== undefined) {
        user32.symbols.SetCursorPos(params.x, params.y);
        Bun.sleepSync(50);
        user32.symbols.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, null);
        Bun.sleepSync(30);
        user32.symbols.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, null);
        return { content: [{ type: "text", text: `Clicked at (${params.x}, ${params.y})` }] };
      }
      if (params.windowTitle && params.elementName) {
        const wins = listWindows();
        const win = wins.find(w => w.title.toLowerCase().includes(params.windowTitle!.toLowerCase()));
        if (!win) return { content: [{ type: "text", text: `Window not found.` }] };
        const elements = accFindElements(win.handle, params.elementName!, 1, 8);
        if (elements.length === 0) return { content: [{ type: "text", text: `Element not found.` }] };

        // Try accDoDefaultAction first
        if (accDoDefaultAction(elements[0].ptr)) {
          return { content: [{ type: "text", text: `Clicked "${elements[0].name}" (${elements[0].role}) via accDoDefaultAction` }] };
        }

        // Fallback: get location and click center
        const cv = Buffer.alloc(24); cv.writeUInt16LE(3, 0);
        const px = Buffer.alloc(4), py = Buffer.alloc(4), pw = Buffer.alloc(4), ph = Buffer.alloc(4);
        // accLocation (vtable 22): this, *left, *top, *width, *height, varChild
        try {
          new _CFunction({ ptr: vte(elements[0].ptr, 22), args: [_FFIType.ptr, _FFIType.ptr, _FFIType.ptr, _FFIType.ptr, _FFIType.ptr, _FFIType.ptr], returns: _FFIType.i32 })(
            elements[0].ptr, _ptr(px), _ptr(py), _ptr(pw), _ptr(ph), _ptr(cv));
          const cx = px.readInt32LE(0) + Math.floor(pw.readInt32LE(0) / 2);
          const cy = py.readInt32LE(0) + Math.floor(ph.readInt32LE(0) / 2);
          user32.symbols.SetCursorPos(cx, cy);
          Bun.sleepSync(50);
          user32.symbols.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, null);
          Bun.sleepSync(30);
          user32.symbols.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, null);
          return { content: [{ type: "text", text: `Clicked "${elements[0].name}" at (${cx}, ${cy})` }] };
        } catch (error) {
          debugSuppressedError(log, "Failed to resolve element location for click fallback.", error, {
            operation: "win_ui.win_click.acc_location",
            windowTitle: params.windowTitle,
            elementName: params.elementName,
            element: elements[0].name,
          });
          return { content: [{ type: "text", text: `Found "${elements[0].name}" but couldn't get location` }] };
        }
      }
      return { content: [{ type: "text", text: "Provide (x, y) or (windowTitle + elementName)" }] };
    },
  });

  pi.registerTool({
    name: "win_type",
    label: "Type Text",
    description: "Send keystrokes to the focused window. Provide text for typing or a virtual key code for special keys.",
    promptSnippet: "win_type: send text or virtual key presses to the focused Windows window.",
    parameters: Type.Object({
      text: Type.Optional(Type.String({ description: "Text to type (Unicode via SendInput)" })),
      vk: Type.Optional(Type.Number({ description: "Virtual key code (e.g. 0x0D=Enter, 0x09=Tab)" })),
      ctrl: Type.Optional(Type.Boolean({ description: "Hold Ctrl" })),
      alt: Type.Optional(Type.Boolean({ description: "Hold Alt" })),
      shift: Type.Optional(Type.Boolean({ description: "Hold Shift" })),
    }),
    async execute(_id, params) {
      if (params.vk !== undefined) {
        const mods: number[] = [];
        if (params.ctrl) mods.push(0x11);
        if (params.alt) mods.push(0x12);
        if (params.shift) mods.push(0x10);
        for (const m of mods) user32.symbols.keybd_event(m, 0, 0, null);
        user32.symbols.keybd_event(params.vk, 0, 0, null);
        Bun.sleepSync(30);
        user32.symbols.keybd_event(params.vk, 0, KEYEVENTF_KEYUP, null);
        for (const m of mods.reverse()) user32.symbols.keybd_event(m, 0, KEYEVENTF_KEYUP, null);
        return { content: [{ type: "text", text: `Sent VK 0x${params.vk.toString(16)}` }] };
      }
      if (params.text) {
        // Type Unicode text via SendInput with KEYEVENTF_UNICODE (pure FFI, no PowerShell)
        // Each INPUT struct is 40 bytes on x64: type(4) + padding(4) + KEYBDINPUT(24) + padding(8)
        // KEYBDINPUT: wVk(2) + wScan(2) + dwFlags(4) + time(4) + dwExtraInfo(8)
        const KEYEVENTF_UNICODE = 0x0004;
        const INPUT_KEYBOARD = 1;
        for (const char of params.text) {
          const code = char.charCodeAt(0);
          // Two INPUT structs per char: key down + key up
          const buf = Buffer.alloc(80);
          // Key down
          buf.writeUInt32LE(INPUT_KEYBOARD, 0);    // type
          buf.writeUInt16LE(0, 8);                  // wVk = 0
          buf.writeUInt16LE(code, 10);              // wScan = Unicode char
          buf.writeUInt32LE(KEYEVENTF_UNICODE, 12); // dwFlags
          // Key up
          buf.writeUInt32LE(INPUT_KEYBOARD, 40);
          buf.writeUInt16LE(0, 48);
          buf.writeUInt16LE(code, 50);
          buf.writeUInt32LE(KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 52);
          user32.symbols.SendInput(2, _ptr(buf), 40);
        }
        return { content: [{ type: "text", text: `Typed "${params.text.substring(0, 50)}"` }] };
      }
      return { content: [{ type: "text", text: "Provide text or vk" }] };
    },
  });

  pi.registerTool({
    name: "win_tree",
    label: "Accessibility Tree",
    description: "Dump the IAccessible tree for a window — shows all interactive elements (buttons, links, tabs, text) with their roles. Useful for discovering what can be clicked.",
    promptSnippet: "win_tree: dump a Windows accessibility tree for a window to inspect clickable elements and roles.",
    parameters: Type.Object({
      windowTitle: Type.String({ description: "Window title substring" }),
      maxDepth: Type.Optional(Type.Number({ description: "Max tree depth (default 6)" })),
      maxElements: Type.Optional(Type.Number({ description: "Max elements to return (default 50)" })),
    }),
    async execute(_id, params) {
      const wins = listWindows();
      const win = wins.find(w => w.title.toLowerCase().includes(params.windowTitle.toLowerCase()));
      if (!win) return { content: [{ type: "text", text: `No window matching "${params.windowTitle}".` }] };

      const ppAcc = Buffer.alloc(8);
      oleacc.symbols.AccessibleObjectFromWindow(win.handle as any, OBJID_CLIENT, _ptr(IID_IAccessible), _ptr(ppAcc));
      const pAcc = Number(ppAcc.readBigUInt64LE(0));
      if (!pAcc) return { content: [{ type: "text", text: "Could not get IAccessible for window." }] };

      const maxD = params.maxDepth ?? 6;
      const maxE = params.maxElements ?? 50;
      const lines: string[] = [];

      function walk(p: number, depth: number) {
        if (depth > maxD || lines.length >= maxE) return;
        const info = accGetInfo(p);
        const indent = "  ".repeat(depth);
        if (info.name || info.roleId >= 0) {
          const label = info.name ? JSON.stringify(info.name).substring(0, 60) : "(unnamed)";
          lines.push(`${indent}${info.role} [${info.children}] ${label}`);
        }
        if (info.children > 0 && info.children <= 50) {
          const kids = accGetChildren(p, 30);
          for (const kid of kids) walk(kid, depth + 1);
        }
      }

      walk(pAcc, 0);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { elements: lines.length, window: win.title } };
    },
  });

  // ── win_kill ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "win_kill",
    label: "Kill Window/Process",
    description: "Close a window by title (WM_CLOSE). With force=true, terminates the owning process. Use to clean up stale Edge instances, dialogs, etc.",
    promptSnippet: "win_kill: close or force-kill Windows windows/processes by title match.",
    parameters: Type.Object({
      titleMatch: Type.String({ description: "Window title substring to match" }),
      force: Type.Optional(Type.Boolean({ description: "Force-kill the owning process (default: false, sends WM_CLOSE)" })),
    }),
    async execute(_id, params) {
      const wins = listWindows();
      const matches = wins.filter(w => w.title.toLowerCase().includes(params.titleMatch.toLowerCase()));
      if (matches.length === 0) return { content: [{ type: "text", text: `No window matching "${params.titleMatch}".` }] };

      const results: any[] = [];
      for (const win of matches) {
        const r = killWindow(win.handle, params.force ?? false);
        results.push({ title: win.title, handle: win.handle, ...r });
      }
      const summary = formatKillSummary(results, params.force ?? false);
      return { content: [{ type: "text", text: summary }], details: results };
    },
  });
}
