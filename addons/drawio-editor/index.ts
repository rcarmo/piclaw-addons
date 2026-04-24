/**
 * drawio-editor/index.ts — Self-hosted draw.io diagram editor extension.
 *
 * Registers an HTTP route at /drawio/* that serves the vendored draw.io
 * webapp in embed mode. The editor communicates via postMessage with a
 * thin wrapper page that handles loading/saving diagrams from the
 * workspace via the piclaw raw file API.
 *
 * Architecture:
 *   - Uses piclaw's registerRoute() (via globalThis.__piclaw_registerRoute)
 *     to serve the draw.io webapp from the vendor/ directory.
 *   - A wrapper page (/drawio/edit.html) embeds the editor in an iframe
 *     and handles the postMessage protocol for load/save.
 *   - Diagrams are stored as .drawio XML files in the workspace.
 */

import { resolve, extname, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
// Tool status hint registration - uses globalThis if available
function registerToolStatusHintProvider(provider) {
    if (typeof globalThis.__piclaw_registerToolStatusHintProvider === "function") {
        globalThis.__piclaw_registerToolStatusHintProvider(provider);
    }
}

// ── Constants ───────────────────────────────────────────────────

const DRAWIO_STATUS_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="2" width="13" height="13" rx="1.5"></rect><circle cx="16" cy="16" r="6.5"></circle></svg>`;

const EXT_DIR = typeof import.meta.dir === "string"
  ? import.meta.dir
  : dirname(new URL(import.meta.url).pathname);
const ROUTE_PREFIX = "/drawio";
const DEFAULT_WORKSPACE_ROOT = "/workspace";
const DRAWIO_VERSION = "v29.6.1";

export function getDrawioVendorDirCandidates(baseDir = EXT_DIR, cwd = process.cwd()): string[] {
  return [
    resolve(baseDir, "vendor"),
    resolve(cwd, "runtime/extensions/viewers/drawio-editor/vendor"),
    resolve(cwd, "piclaw/runtime/extensions/viewers/drawio-editor/vendor"),
    resolve(cwd, "generated/cache/vendor/drawio", DRAWIO_VERSION),
    resolve(cwd, "piclaw/generated/cache/vendor/drawio", DRAWIO_VERSION),
  ];
}

export function resolveDrawioVendorDir(baseDir = EXT_DIR, cwd = process.cwd()): string {
  for (const candidate of getDrawioVendorDirCandidates(baseDir, cwd)) {
    if (existsSync(resolve(candidate, "index.html"))) {
      return candidate;
    }
  }
  return resolve(baseDir, "vendor");
}

const VENDOR_DIR = resolveDrawioVendorDir();

const DRAWIO_EXTENSIONS = [".drawio", ".drawio.xml", ".drawio.svg", ".drawio.png"];
const EXPORT_EXTENSIONS: Record<string, string> = {
  "image/svg+xml": ".svg",
  "image/png": ".png",
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "text/xml": ".xml",
  "application/xml": ".xml",
};
const DEFAULT_DRAWIO_XML = '<mxfile host="app.diagrams.net"><diagram id="page-1" name="Page-1"><mxGraphModel dx="1260" dy="720" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".xml": "application/xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const DRAWIO_FRAME_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; " +
  "frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

export const MINIMAL_DRAWIO_EXPORT_ACTIONS = ["exportPng", "exportJpg", "exportSvg"] as const;
export const MINIMAL_DRAWIO_FILE_MENU_ACTIONS = ["save", "-"] as const;

// Keep this helper self-contained: we stringify it into the wrapper page below,
// so it must not capture module-scope names like ROUTE_PREFIX.
export function buildEmbeddedDrawioAppUrl(isDark: boolean, readOnly = false, routePrefix = "/drawio"): string {
  let editorUrl = `${routePrefix}/index.html?embed=1&proto=json&spin=1&modified=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0&libraries=0&ui=dark&dark=${isDark ? "1" : "0"}`;
  if (readOnly) {
    editorUrl += '&chrome=0&toolbar=0&layers=0&edit=0';
  }
  return editorUrl;
}

// Keep this helper self-contained too: the wrapper page stringifies it so the
// runtime check and the TypeScript regression tests share the same trust rule.
export function isTrustedDrawioMessageEvent(
  eventOrigin: string,
  expectedOrigin: string,
  eventSource: unknown,
  frameWindow: unknown,
): boolean {
  return Boolean(frameWindow) && eventSource === frameWindow && eventOrigin === expectedOrigin;
}

export function isExplicitDrawioExportRequest(mimeType?: string, filename?: string): boolean {
  const explicitMime = mimeType && !/^(application|text)\/xml$/i.test(mimeType)
    ? EXPORT_EXTENSIONS[mimeType || ""]
    : "";
  const explicitExt = extname(filename || "");
  return Boolean(explicitMime || (explicitExt && !/^\.drawio$/i.test(explicitExt)));
}

export function resolveDrawioSavePath(path: string, mimeType?: string, filename?: string): string {
  if (!isExplicitDrawioExportRequest(mimeType, filename)) {
    return path;
  }
  const ext = EXPORT_EXTENSIONS[mimeType || ""] || "";
  return replaceExtension(path, ext || extname(filename || "") || extname(path) || ".drawio");
}

export function isBinaryDrawioSaveTarget(savePath: string, format?: string, mimeType?: string): boolean {
  const lower = String(savePath || "").toLowerCase();
  return lower.endsWith(".png")
    || lower.endsWith(".jpg")
    || lower.endsWith(".jpeg")
    || lower.endsWith(".pdf")
    || format === "xmlpng"
    || format === "png"
    || format === "jpg"
    || format === "jpeg"
    || mimeType === "image/png"
    || mimeType === "image/jpeg"
    || mimeType === "image/jpg"
    || mimeType === "application/pdf";
}

function readTrimmedString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

registerToolStatusHintProvider({
  id: "drawio_editor",
  buildHints: ({ toolName, args }) => {
    if (toolName !== "open_drawio_editor") return null;
    const record = args && typeof args === "object" ? args as Record<string, unknown> : null;
    const path = readTrimmedString(record?.path);
    if (!path) return null;
    return {
      key: "open_drawio_editor",
      icon_svg: DRAWIO_STATUS_ICON_SVG,
      label: path,
      title: `Draw.io editor • ${path}`,
      kind: "file",
    };
  },
});

// ── Editor wrapper page ─────────────────────────────────────────

/**
 * Generates the wrapper HTML page that embeds draw.io in an iframe
 * and handles the postMessage protocol for load/save.
 */
function generateEditorPage(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Draw.io Editor</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #1e1e1e; }
  #editor-frame { width: 100%; height: 100%; border: none; }
  .loading {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    color: #999; font-family: system-ui, sans-serif; font-size: 14px;
    text-align: center;
  }
  .loading.hidden { display: none; }
  .readonly-lock {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: none;
    cursor: not-allowed;
    background: transparent;
  }
  .readonly-lock.active { display: block; }
</style>
</head>
<body>
<div id="loading" class="loading">Loading draw.io editor…</div>
<div id="readonly-lock" class="readonly-lock" aria-hidden="true"></div>
<iframe id="editor-frame" style="display:none"></iframe>
<script>
'use strict';

var params = new URLSearchParams(location.search);
var hashParams = new URLSearchParams((location.hash || '').replace(/^#/, ''));

function getFlexibleParam(name) {
  var direct = params.get(name);
  if (direct) return direct;
  for (var it = params.entries(), next = it.next(); !next.done; next = it.next()) {
    var key = String(next.value[0] || '');
    var normalized = key.replace(/^amp;/i, '');
    if (normalized === name) return String(next.value[1] || '');
  }
  return '';
}

function firstNonEmpty(parts) {
  for (var i = 0; i < parts.length; i++) {
    if (parts[i]) return parts[i];
  }
  return '';
}

var filePath = firstNonEmpty([
  getFlexibleParam('path'),
  hashParams.get('path') || '',
]);

var mediaId = firstNonEmpty([
  getFlexibleParam('media'),
  hashParams.get('media') || '',
]);

var explicitName = firstNonEmpty([
  getFlexibleParam('name'),
  hashParams.get('name') || '',
]);

var readOnly = /^(1|true|yes)$/i.test(firstNonEmpty([
  getFlexibleParam('readonly'),
  hashParams.get('readonly') || '',
]));

// Attachment preview mode is always read-only.
if (!filePath && /^\\d+$/.test(mediaId) && Number(mediaId) > 0) {
  readOnly = true;
}

var sourceName = explicitName || filePath || ('attachment-' + mediaId + '.drawio');
var fileName = sourceName.split('/').pop() || 'diagram.drawio';
document.title = fileName + ' · Draw.io';
var frame = document.getElementById('editor-frame');
var loading = document.getElementById('loading');
var readonlyLock = document.getElementById('readonly-lock');
var expectedFrameOrigin = window.location.origin;
if (readOnly && readonlyLock) readonlyLock.classList.add('active');
var DEFAULT_DRAWIO_XML = ${JSON.stringify(DEFAULT_DRAWIO_XML)};
var xmlData = DEFAULT_DRAWIO_XML;
var modified = false;
var format = (function() {
  var lower = String(sourceName || '').toLowerCase();
  if (lower.endsWith('.drawio.svg') || lower.endsWith('.svg')) return 'xmlsvg';
  if (lower.endsWith('.drawio.png') || lower.endsWith('.png')) return 'xmlpng';
  return 'xml';
})();

function normalizeDrawioXml(value) {
  var text = String(value || '').trim();
  return text || DEFAULT_DRAWIO_XML;
}

function bytesToBase64(bytes) {
  var binary = '';
  var chunk = 0x8000;
  for (var i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.slice(i, i + chunk)));
  }
  return btoa(binary);
}

function responseToDataUri(response, fallbackMimeType) {
  return response.arrayBuffer().then(function(buf) {
    var bytes = new Uint8Array(buf);
    var mimeType = response.headers.get('Content-Type') || fallbackMimeType;
    return 'data:' + mimeType + ';base64,' + bytesToBase64(bytes);
  });
}

function patchDrawioExportTarget(win) {
  try {
    // Draw.io does not expose one stable global EditorUi instance in this embed
    // mode, so we patch the relevant constructors/prototypes instead of trying to
    // discover a live UI object after startup.
    function postExport(payload) {
      var target = (win && (win.parent || win.opener)) || window;
      target.postMessage(JSON.stringify(Object.assign({ event: 'workspace-export' }, payload)), '*');
      return true;
    }

    var editorUiCtor = win && win.EditorUi;
    var savePatched = !!(editorUiCtor && editorUiCtor.prototype && editorUiCtor.prototype.__piclawWorkspaceSavePatched);
    if (editorUiCtor && editorUiCtor.prototype && !savePatched) {
      // Save As still routes through EditorUi.saveData, so intercept that once
      // and bounce the payload back to the wrapper for workspace persistence.
      var originalSaveData = editorUiCtor.prototype.saveData;
      editorUiCtor.prototype.saveData = function(filename, format, data, mime, base64Encoded, defaultMode) {
        try {
          if (filename && data != null && postExport({ filename, format, data, xml: mime === 'application/xml' || mime === 'text/xml' ? data : undefined, mimeType: mime, base64Encoded: !!base64Encoded, defaultMode: defaultMode })) {
            return;
          }
        } catch (err) {
          console.warn('[drawio] saveData intercept failed, falling back to native save', err);
        }
        return originalSaveData.apply(this, arguments);
      };
      editorUiCtor.prototype.__piclawWorkspaceSavePatched = true;
      savePatched = true;
    }

    var appCtor = win && win.App;
    var exportPatched = !!(appCtor && appCtor.prototype && appCtor.prototype.__piclawExportPatched);
    if (appCtor && appCtor.prototype && !exportPatched) {
      // Non-XML exports (PNG/JPEG/SVG) go through App.exportFile.
      var original = appCtor.prototype.exportFile;
      appCtor.prototype.exportFile = function(data, filename, mimeType, base64Encoded, mode, folderId) {
        try {
          if (filename && postExport({ filename: filename, mimeType: mimeType, base64Encoded: !!base64Encoded, data: data, mode: mode, folderId: folderId })) {
            return;
          }
        } catch (err) {
          console.warn('[drawio] export intercept failed, falling back to native export', err);
        }
        return original.apply(this, arguments);
      };
      appCtor.prototype.__piclawExportPatched = true;
      exportPatched = true;
    }

    var actionsCtor = win && win.Actions;
    var actionsPatched = !!(actionsCtor && actionsCtor.prototype && actionsCtor.prototype.__piclawMinimalExportActionsPatched);
    if (actionsCtor && actionsCtor.prototype && !actionsPatched) {
      // Hide the unsupported built-in save/export chrome in embedded mode. Keep
      // the normal Save action enabled so File -> Save still posts the standard
      // XML save event back through the wrapper.
      var originalActionGet = actionsCtor.prototype.get;
      actionsCtor.prototype.get = function(name) {
        var action = originalActionGet.apply(this, arguments);
        if (!action) return action;
        var actionName = String(name || '');
        if (!action.__piclawMinimalExportActionPatched && ['saveAs', 'saveAs...', 'exit', 'export', 'exportWebp', 'exportAnimatedGif', 'exportPdf', 'exportVsdx', 'exportHtml', 'exportXml', 'exportUrl', 'publishLink'].indexOf(actionName) >= 0) {
          action.setEnabled && action.setEnabled(false);
          action.isEnabled = function() { return false; };
        }
        action.__piclawMinimalExportActionPatched = true;
        return action;
      };
      actionsCtor.prototype.__piclawMinimalExportActionsPatched = true;
      actionsPatched = true;
    }

    var menusCtor = win && win.Menus;
    var menusPatched = !!(menusCtor && menusCtor.prototype && menusCtor.prototype.__piclawMinimalExportMenusPatched);
    if (menusCtor && menusCtor.prototype && !menusPatched) {
      // Patch Menus#get instead of mutating one live menu instance. This survives
      // Draw.io rebuilding menus and avoids depending on undocumented globals.
      var originalMenuGet = menusCtor.prototype.get;
      menusCtor.prototype.get = function(name) {
        var menu = originalMenuGet.apply(this, arguments);
        if (!menu) return menu;
        var menus = this;
        var menuName = String(name || '');
        if (menuName === 'importFrom' || menuName === 'embed') {
          // Disable menu groups that expose flows we do not support in the
          // packaged workspace editor.
          menu.setEnabled && menu.setEnabled(false);
          menu.isEnabled = function() { return false; };
          return menu;
        }
        if (menu.__piclawMinimalExportMenuPatched) return menu;
        if (menuName === 'exportAs') {
          // Keep the reduced export menu limited to the formats we can round-trip
          // safely through the wrapper.
          menu.funct = function(menuElt, parent) {
            menus.addMenuItems(menuElt, ${JSON.stringify(Array.from(MINIMAL_DRAWIO_EXPORT_ACTIONS))}, parent);
          };
        } else if (menuName === 'file' || menuName === 'diagram') {
          // Some Draw.io builds expose File, others also expose Diagram. Keep a
          // plain Save entry, then point the rest of the menu at the reduced
          // Export As submenu.
          menu.funct = function(menuElt, parent) {
            menus.addMenuItems(menuElt, ${JSON.stringify(Array.from(MINIMAL_DRAWIO_FILE_MENU_ACTIONS))}, parent);
            menus.addSubmenu('exportAs', menuElt, parent);
          };
        }
        menu.__piclawMinimalExportMenuPatched = true;
        return menu;
      };
      menusCtor.prototype.__piclawMinimalExportMenusPatched = true;
      menusPatched = true;
    }

    return !!(savePatched && exportPatched && actionsPatched && menusPatched);
  } catch (_) {
    return false;
  }
}

function saveWorkspace(payload, acknowledge) {
  return fetch('/drawio/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: filePath,
      targetPath: payload.targetPath,
      format: payload.format || format,
      xml: payload.xml,
      data: payload.data,
      mimeType: payload.mimeType,
      filename: payload.filename,
      base64Encoded: payload.base64Encoded
    })
  }).then(async function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var result = null;
    try {
      result = await r.json();
    } catch (_) {
      result = null;
    }
    if (payload.targetPath && result && result.path) {
      filePath = result.path;
      fileName = String(filePath).split('/').pop() || fileName;
      try {
        var nextUrl = location.pathname + '?path=' + encodeURIComponent(filePath);
        history.replaceState(null, '', nextUrl);
      } catch (_) {
        // ignore history update failures
      }
    }
    if (acknowledge && frame.contentWindow) {
      frame.contentWindow.postMessage(JSON.stringify({
        action: 'status',
        message: payload.targetPath ? ('Saved as ' + fileName) : 'Saved',
        modified: false
      }), '*');
    }
  });
}

// Load the file contents from workspace or media attachment
function loadFile() {
  if (!filePath && !(/^\\d+$/.test(mediaId) && Number(mediaId) > 0)) {
    xmlData = DEFAULT_DRAWIO_XML;
    startEditor();
    return;
  }

  var sourceUrl = filePath
    ? ('/workspace/raw?path=' + encodeURIComponent(filePath))
    : ('/media/' + encodeURIComponent(mediaId));

  fetch(sourceUrl)
    .then(function(r) {
      if (r.ok) {
        if (format === 'xmlsvg') return responseToDataUri(r, 'image/svg+xml');
        if (format === 'xmlpng') return responseToDataUri(r, 'image/png');
        return r.text();
      }
      if (r.status === 404 && filePath) return DEFAULT_DRAWIO_XML; // new workspace file
      throw new Error('HTTP ' + r.status);
    })
    .then(function(text) {
      xmlData = format === 'xml' ? normalizeDrawioXml(text) : String(text || DEFAULT_DRAWIO_XML);
      startEditor();
    })
    .catch(function(err) {
      loading.textContent = 'Failed to load: ' + err.message;
    });
}

function startEditor() {
  // Embed mode URL with dark theme. Keep using the shared helper so the TS
  // tests and the stringified browser copy stay in lockstep.
  var isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var editorUrl = (${buildEmbeddedDrawioAppUrl.toString()})(!!isDark, !!readOnly);
  function tryPatch() {
    if (readOnly || !frame.contentWindow) return;
    if (patchDrawioExportTarget(frame.contentWindow)) return;
    setTimeout(tryPatch, 50);
  }
  frame.src = editorUrl;
  frame.style.display = 'block';
  frame.onload = function() {
    tryPatch();
  };
  tryPatch();
}

// Handle postMessage from draw.io iframe
window.addEventListener('message', function(e) {
  var msg;
  try { msg = JSON.parse(e.data); } catch(_) { return; }
  if (!(${isTrustedDrawioMessageEvent.toString()})(e.origin, expectedFrameOrigin, e.source, frame.contentWindow)) return;

  switch (msg.event) {
    case 'init':
      loading.classList.add('hidden');
      // Send load action with the diagram XML
      frame.contentWindow.postMessage(JSON.stringify({
        action: 'load',
        xml: format === 'xml' ? normalizeDrawioXml(xmlData) : xmlData,
        autosave: readOnly ? 0 : 1,
        saveAndExit: '0',
        noSaveBtn: '1',
        noExitBtn: '1',
        title: fileName
      }), '*');
      break;

    case 'autosave':
      if (readOnly || !filePath || !msg.xml) break;
      modified = true;
      if (format === 'xml') {
        saveWorkspace({ xml: msg.xml, format: 'xml' }, false).catch(function(err) {
          console.error('[drawio] autosave error:', err);
        });
      } else {
        xmlData = msg.xml;
      }
      break;

    case 'save':
      if (readOnly || !filePath || !msg.xml) break;
      modified = true;
      if (format === 'xml') {
        saveWorkspace({ xml: msg.xml, format: 'xml' }, true).catch(function(err) {
          console.error('[drawio] save error:', err);
        });
      } else {
        xmlData = msg.xml;
        frame.contentWindow.postMessage(JSON.stringify({
          action: 'export',
          format: format,
          xml: msg.xml,
          spinKey: 'export'
        }), '*');
      }
      break;

    case 'export':
      if (readOnly || !filePath || !msg.data) break;
      saveWorkspace({
        data: msg.data,
        format: format,
        xml: msg.xml
      }, true).catch(function(err) {
        console.error('[drawio] export save error:', err);
      });
      break;

    case 'workspace-export':
      if (readOnly || !filePath || !msg.data) break;
      saveWorkspace({
        data: msg.data,
        xml: msg.xml,
        format: msg.format || format,
        mimeType: msg.mimeType,
        filename: msg.filename,
        base64Encoded: !!msg.base64Encoded
      }, true).catch(function(err) {
        console.error('[drawio] workspace export save error:', err);
      });
      break;

    case 'exit':
      // User closed the editor — navigate back or close
      if (window.opener) {
        window.close();
      } else {
        history.back();
      }
      break;
  }
});

loadFile();
</script>
</body>
</html>`;
}

// ── Route handler ───────────────────────────────────────────────

function getMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function getWorkspaceRoot(): string {
  return process.env.PICLAW_WORKSPACE || DEFAULT_WORKSPACE_ROOT;
}

function normalizeWorkspaceRelativePath(input: string): string {
  const trimmed = String(input || "").trim().replace(/^@/, "").replace(/\\+/g, "/");
  if (!trimmed) throw new Error("Missing path");
  const stripped = trimmed.replace(/^\/workspace\//, "").replace(/^\/+/, "");
  const normalized = stripped
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .reduce<string[]>((parts, segment) => {
      if (segment === "..") {
        if (parts.length === 0) throw new Error("Forbidden path");
        parts.pop();
        return parts;
      }
      parts.push(segment);
      return parts;
    }, [])
    .join("/");
  if (!normalized) throw new Error("Missing path");
  return normalized;
}

function resolveWorkspacePath(path: string): string {
  const workspaceRoot = getWorkspaceRoot();
  const relative = normalizeWorkspaceRelativePath(path);
  const fullPath = resolve(workspaceRoot, relative);
  const realRoot = realpathSync(workspaceRoot);
  const parentDir = resolve(fullPath, "..");
  const realParent = existsSync(parentDir) ? realpathSync(parentDir) : realpathSync(workspaceRoot);
  if (!fullPath.startsWith(realRoot) || !realParent.startsWith(realRoot)) {
    throw new Error("Forbidden path");
  }
  return fullPath;
}

function decodeDataUri(dataUri: string): { mimeType: string | null; bytes: Uint8Array } {
  const match = String(dataUri || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) {
    return { mimeType: null, bytes: new TextEncoder().encode(String(dataUri || "")) };
  }
  const mimeType = match[1] || null;
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  if (isBase64) {
    return { mimeType, bytes: Uint8Array.from(Buffer.from(payload, "base64")) };
  }
  return { mimeType, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
}

function replaceExtension(path: string, extension: string): string {
  const lower = String(path || "").toLowerCase();
  if (lower.endsWith(".drawio.svg") || lower.endsWith(".drawio.png") || lower.endsWith(".drawio.xml")) {
    return path.replace(/\.drawio\.(svg|png|xml)$/i, extension);
  }
  if (lower.endsWith(".drawio")) {
    return path.replace(/\.drawio$/i, extension);
  }
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? `${path.slice(0, idx)}${extension}` : `${path}${extension}`;
}

async function handleSaveRequest(req: Request): Promise<Response> {
  let data: { path?: string; targetPath?: string; format?: string; xml?: string; data?: string; mimeType?: string; filename?: string; base64Encoded?: boolean };
  try {
    data = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  if (!data?.path) {
    return new Response(JSON.stringify({ error: "Missing path" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  try {
    const savePath = resolveDrawioSavePath(String(data.targetPath || data.path), data.mimeType, data.filename);
    const targetPath = resolveWorkspacePath(savePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    const lower = savePath.toLowerCase();

    if (data.base64Encoded && data.data && !String(data.data).startsWith("data:")) {
      const mime = data.mimeType
        || (lower.endsWith(".svg") ? "image/svg+xml"
          : lower.endsWith(".png") ? "image/png"
            : (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) ? "image/jpeg"
              : "application/octet-stream");
      data.data = `data:${mime};base64,${data.data}`;
    }

    if (lower.endsWith(".svg") || data.format === "xmlsvg" || data.format === "svg") {
      if (!data.data) throw new Error("Missing SVG data");
      const decoded = decodeDataUri(data.data);
      writeFileSync(targetPath, Buffer.from(decoded.bytes).toString("utf8"), "utf8");
    } else if (isBinaryDrawioSaveTarget(savePath, data.format, data.mimeType)) {
      if (!data.data) throw new Error("Missing export data");
      const decoded = decodeDataUri(data.data);
      writeFileSync(targetPath, decoded.bytes);
    } else {
      writeFileSync(targetPath, data.xml ?? DEFAULT_DRAWIO_XML, "utf8");
    }

    return new Response(JSON.stringify({ ok: true, path: savePath }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

export function handleRoute(req: Request, pathname: string): Response | Promise<Response> | null {
  if (req.method === "POST" && pathname === "/drawio/save") {
    return handleSaveRequest(req);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Serve the editor wrapper page
  let relative = pathname.replace(/^\/drawio\/?/, "") || "";
  const qIdx = relative.indexOf("?");
  if (qIdx >= 0) relative = relative.substring(0, qIdx);

  // /drawio/edit or /drawio/edit.html → wrapper page
  if (relative === "" || relative === "edit" || relative === "edit.html") {
    return new Response(generateEditorPage(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        // Allow embedding in same-origin iframes (pane system)
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": DRAWIO_FRAME_CSP,
      },
    });
  }

  if (relative.includes("..") || relative.startsWith("/")) {
    return new Response("Forbidden", { status: 403 });
  }

  // Serve vendored draw.io files
  const filePath = resolve(VENDOR_DIR, relative);

  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  if (!existsSync(realPath)) {
    return new Response("Not Found", { status: 404 });
  }

  const st = statSync(realPath);
  if (!st.isFile()) {
    return new Response("Not Found", { status: 404 });
  }

  const cacheControl = relative === "js/PreConfig.js" || relative === "js/PostConfig.js"
    ? "no-cache"
    : "public, max-age=86400";

  return new Response(Bun.file(realPath), {
    headers: {
      "Content-Type": getMimeType(realPath),
      "Content-Length": String(st.size),
      // draw.io JS is versioned by release; config files stay uncached so
      // self-hosted overrides take effect immediately after reload.
      "Cache-Control": cacheControl,
      // Override global X-Frame-Options: DENY so the draw.io editor
      // can be loaded inside same-origin iframes.
      "X-Frame-Options": "SAMEORIGIN",
      // Override the global CSP frame-ancestors 'none' so draw.io can be
      // embedded by our wrapper page and pane iframe on the same origin.
      "Content-Security-Policy": DRAWIO_FRAME_CSP,
    },
  });
}

// ── Extension entry point ───────────────────────────────────────

export default function drawioEditor(pi: any) {
  // Register the HTTP route
  const registerRoute = (globalThis as any).__piclaw_registerRoute as
    | ((prefix: string, handler: typeof handleRoute, extensionPath?: string) => "created" | "updated")
    | undefined;
  if (typeof registerRoute === "function") {
    const registration = registerRoute(ROUTE_PREFIX, handleRoute, EXT_DIR);
    if (registration === "created") {
      console.log(`[drawio-editor] Route registered: /drawio/* → ${VENDOR_DIR}`);
    }
  } else {
    console.warn("[drawio-editor] WARNING: __piclaw_registerRoute not available.");
  }

  // Register tool for the LLM to open the diagram editor
  pi.registerTool({
    name: "open_drawio_editor",
    label: "Open Draw.io Editor",
    description:
      "Open or create a .drawio diagram file in the web UI draw.io pane when available. " +
      "Returns a fallback URL when direct pane opening is unavailable.",
    promptSnippet: "open_drawio_editor: open/create a draw.io file in the web UI draw.io pane.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace path to the .drawio file (created if it doesn't exist).",
        },
      },
      required: ["path"],
    },
    async execute(_toolCallId: string, params: { path: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      const filePath = normalizeWorkspaceRelativePath(params.path || "");

      // Validate extension
      const hasValidExt = DRAWIO_EXTENSIONS.some(ext => filePath.toLowerCase().endsWith(ext));
      if (!hasValidExt && !filePath.toLowerCase().endsWith(".xml")) {
        throw new Error(
          `Unsupported file type. Expected: ${DRAWIO_EXTENSIONS.join(", ")} or .xml`
        );
      }

      const absolutePath = resolveWorkspacePath(filePath);
      if (!existsSync(absolutePath)) {
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, DEFAULT_DRAWIO_XML, "utf8");
      } else {
        const stat = statSync(absolutePath);
        if (!stat.isFile()) {
          throw new Error(`Not a file: ${filePath}`);
        }
      }

      const editorUrl = `${ROUTE_PREFIX}/edit?path=${encodeURIComponent(filePath)}`;
      const label = filePath.split("/").pop() || "diagram.drawio";

      if (ctx?.hasUI && typeof ctx?.ui?.custom === "function") {
        try {
          const outcome = await ctx.ui.custom(
            () => null,
            {
              timeout: 15000,
              action: "open_workspace_file",
              path: filePath,
              label,
              target: "tab",
            },
          ) as { ok?: boolean; opened?: boolean; target?: string; detail?: string; reason?: string } | undefined;

          if (outcome?.ok !== false && outcome?.opened !== false) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Opened ${filePath} in the Draw.io editor pane.`,
                },
              ],
              details: { ok: true, opened: true, path: filePath, target: outcome?.target || "tab", editorUrl },
            };
          }

          const detail = typeof outcome?.detail === "string" && outcome.detail.trim()
            ? outcome.detail.trim()
            : "The web UI did not open the Draw.io pane directly.";
          return {
            content: [
              {
                type: "text" as const,
                text: `${detail}\n\nFallback URL: ${editorUrl}`,
              },
            ],
            details: {
              ok: false,
              opened: false,
              reason: outcome?.reason || "ui_open_failed",
              path: filePath,
              target: "tab",
              editorUrl,
            },
          };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error || "Unknown UI error");
          return {
            content: [
              {
                type: "text" as const,
                text: `Could not open the Draw.io pane directly.\n\nFallback URL: ${editorUrl}\n\nReason: ${detail}`,
              },
            ],
            details: { ok: false, opened: false, reason: "ui_open_failed", path: filePath, target: "tab", editorUrl },
          };
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Draw.io editor URL: ${editorUrl}\n\nOpen this URL in the browser to edit the diagram. Changes are auto-saved to the workspace.`,
          },
        ],
        details: { editorUrl, path: filePath },
      };
    },
  });
}
