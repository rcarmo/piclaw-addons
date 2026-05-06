/**
 * office-viewer/index.ts — Lightweight Office document viewer addon for Piclaw.
 *
 * Registers an HTTP route at /office-viewer/* that serves a self-contained
 * viewer page using browser-side JS libraries:
 *   - docx-preview  (.docx, .doc, .odt, .rtf)
 *   - SheetJS/xlsx  (.xlsx, .xls, .ods, .csv)
 *   - PptxViewJS    (.pptx, .ppt, .odp)
 *
 * No WASM, no SharedArrayBuffer, no HTTPS requirement.
 * Works over plain HTTP.
 *
 * Uses piclaw's __piclaw_registerRoute global to serve vendor assets
 * and __piclaw_registerToolStatusHintProvider for tool progress hints.
 */

import { resolve, extname, dirname } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";

// ── Constants ───────────────────────────────────────────────────

const EXT_DIR = typeof import.meta.dir === "string"
  ? import.meta.dir
  : dirname(new URL(import.meta.url).pathname);
const VENDOR_DIR = resolve(EXT_DIR, "vendor");
const ROUTE_PREFIX = "/office-viewer";

const OFFICE_VIEWER_STATUS_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 3h10l4 4v14H4z"></path><path d="M14 3v5h4"></path><circle cx="16" cy="18" r="3.5"></circle><path d="M18.5 20.5l2.5 2.5"></path></svg>`;

const OFFICE_EXTENSIONS = [
  ".docx", ".doc", ".odt", ".rtf",
  ".xlsx", ".xls", ".ods", ".csv",
  ".pptx", ".ppt", ".odp",
];

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Standard security headers — no COOP/COEP needed (no WASM workers). */
const HEADERS: Record<string, string> = {
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
};

// ── Helpers ─────────────────────────────────────────────────────

function readTrimmedString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function getMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function registerToolStatusHintProvider(provider: {
  id: string;
  buildHints: (ctx: { toolName: string; args: unknown }) => unknown;
}): void {
  const fn = (globalThis as any).__piclaw_registerToolStatusHintProvider;
  if (typeof fn === "function") fn(provider);
}

// ── Route handler ───────────────────────────────────────────────

function handleRoute(req: Request, pathname: string): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: HEADERS });
  }

  let relative = pathname.replace(/^\/office-viewer\/?/, "") || "viewer.html";
  const qIdx = relative.indexOf("?");
  if (qIdx >= 0) relative = relative.substring(0, qIdx);

  if (relative.includes("..") || relative.startsWith("/")) {
    return new Response("Forbidden", { status: 403, headers: HEADERS });
  }

  const filePath = resolve(VENDOR_DIR, relative);
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch {
    return new Response("Not Found", { status: 404, headers: HEADERS });
  }

  if (!existsSync(realPath) || !statSync(realPath).isFile()) {
    return new Response("Not Found", { status: 404, headers: HEADERS });
  }

  return new Response(Bun.file(realPath), {
    headers: {
      ...HEADERS,
      "Content-Type": getMimeType(realPath),
      "Content-Length": String(statSync(realPath).size),
      "Cache-Control": "no-cache",
    },
  });
}

// ── Extension entry point ───────────────────────────────────────

export default function officeViewer(pi: any) {
  // Register the /office-viewer/* route to serve viewer assets.
  const registerRoute = (globalThis as any).__piclaw_registerRoute as
    | ((prefix: string, handler: typeof handleRoute, extensionPath?: string) => "created" | "updated")
    | undefined;

  if (typeof registerRoute === "function") {
    const result = registerRoute(ROUTE_PREFIX, handleRoute, EXT_DIR);
    if (result === "created") {
      console.log("[office-viewer] Route registered: /office-viewer/* → " + VENDOR_DIR);
    }
  } else {
    console.warn("[office-viewer] WARNING: __piclaw_registerRoute not available. Route NOT registered.");
  }

  // Register tool status hints (shows file path during open_office_viewer calls).
  registerToolStatusHintProvider({
    id: "office_viewer",
    buildHints: ({ toolName, args }) => {
      if (toolName !== "open_office_viewer") return null;
      const record = args && typeof args === "object" ? args as Record<string, unknown> : null;
      const path = readTrimmedString(record?.path);
      if (!path) return null;
      return {
        key: "open_office_viewer",
        icon_svg: OFFICE_VIEWER_STATUS_ICON_SVG,
        label: path,
        title: `Office viewer • ${path}`,
        kind: "file",
      };
    },
  });

  // Register the open_office_viewer tool.
  pi.registerTool({
    name: "open_office_viewer",
    label: "Open Office Viewer",
    description:
      "Open an Office document (.docx, .xlsx, .pptx, .odt, .ods, .odp) in the built-in Office viewer. " +
      "Returns a URL the user can open in their browser.",
    promptSnippet: "open_office_viewer: open Office documents in the built-in browser viewer.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace path to the Office document." },
      },
      required: ["path"],
    },
    async execute(_toolCallId: string, params: { path: string }) {
      const filePath = params.path.replace(/^@/, "");
      const ext = extname(filePath).toLowerCase();

      if (!OFFICE_EXTENSIONS.includes(ext)) {
        throw new Error(
          `Unsupported file type: ${ext}. Supported: ${OFFICE_EXTENSIONS.join(", ")}`
        );
      }

      const fullPath = resolve(process.cwd(), filePath);
      if (!existsSync(fullPath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const rawUrl = `/workspace/raw?path=${encodeURIComponent(filePath)}`;
      const nameStr = filePath.split("/").pop() ?? "document";
      const viewerUrl = `${ROUTE_PREFIX}/?url=${encodeURIComponent(rawUrl)}&name=${encodeURIComponent(nameStr)}`;

      return {
        content: [
          {
            type: "text" as const,
            text: `Office viewer URL: ${viewerUrl}\n\nThe user can open this in their browser to view the document.`,
          },
        ],
        details: { viewerUrl, path: filePath, format: ext },
      };
    },
  });
}


// ── PDF viewer route ─────────────────────────────────────────────
/**
 * pdf-viewer-route.ts — Lightweight authenticated PDF viewer route.
 *
 * Serves:
 *   - /pdf-viewer            -> same-origin HTML PDF wrapper
 *   - /pdf-viewer/?path=...  -> workspace file preview
 *   - /pdf-viewer/?media=... -> media attachment preview
 *   - /pdf-viewer/source?... -> inline PDF stream for attachment previews
 */

// PDF viewer route — appended to @rcarmo/piclaw-addon-office-viewer backend
const PICLAW_PORT_PDF = process.env.PICLAW_WEB_PORT || process.env.PICLAW_PORT || "8080";
const PICLAW_BASE_PDF = `http://localhost:${PICLAW_PORT_PDF}`;

const ROUTE_PREFIX = "/pdf-viewer";

const VIEWER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function generatePdfViewerPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDF Viewer</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: #1e1e1e;
    color: #e0e0e0;
    font-family: system-ui, -apple-system, sans-serif;
  }
  object {
    width: 100%;
    height: 100%;
    border: none;
    display: block;
    background: #1e1e1e;
  }
  .empty {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    color: #888;
    font: 14px system-ui, -apple-system, sans-serif;
    padding: 24px;
    text-align: center;
  }
  .fallback {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .fallback-card {
    max-width: 420px;
    text-align: center;
  }
  .fallback-card a {
    color: #7dc3ff;
  }
</style>
</head>
<body>
<script>
(function () {
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

  var path = firstNonEmpty([
    getFlexibleParam('path'),
    hashParams.get('path') || '',
  ]);

  var media = firstNonEmpty([
    getFlexibleParam('media'),
    hashParams.get('media') || '',
  ]);

  var explicitName = firstNonEmpty([
    getFlexibleParam('name'),
    hashParams.get('name') || '',
  ]);

  var sourceUrl = '';
  if (path) {
    sourceUrl = '/workspace/raw?path=' + encodeURIComponent(path);
  } else if (/^\\d+$/.test(media) && Number(media) > 0) {
    sourceUrl = '/pdf-viewer/source?media=' + encodeURIComponent(media);
  }

  if (!sourceUrl) {
    document.body.innerHTML = '<div class="empty">Missing <code>?path=...</code> or <code>?media=...</code> query parameter.</div>';
    return;
  }

  var inferredName = path ? (path.split('/').pop() || 'document.pdf') : ('attachment-' + media + '.pdf');
  var name = explicitName || inferredName;

  var objectEl = document.createElement('object');
  objectEl.data = sourceUrl;
  objectEl.type = 'application/pdf';
  objectEl.setAttribute('aria-label', name);
  objectEl.innerHTML = '<div class="fallback"><div class="fallback-card"><p>PDF preview is unavailable in this browser context.</p><p><a href="' + sourceUrl + '" target="_blank" rel="noopener noreferrer">Open PDF in a new tab</a></p></div></div>';
  document.body.appendChild(objectEl);
})();
</script>
</body>
</html>`;
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

async function handlePdfMediaSource(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const mediaId = parsePositiveInt(url.searchParams.get("media"));
  if (!mediaId) {
    return new Response("Missing or invalid media id", { status: 400 });
  }

  let mediaRes: Response;
  try {
    mediaRes = await fetch(`${PICLAW_BASE_PDF}/media/${mediaId}`, { method: req.method });
  } catch {
    return new Response("Media service unavailable", { status: 503 });
  }
  if (!mediaRes.ok) return new Response("Not Found", { status: 404 });
  const contentType = (mediaRes.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.includes("application/pdf")) {
    return new Response("Unsupported Media Type", { status: 415 });
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/pdf",
    "Content-Disposition": "inline",
    "Cache-Control": "no-cache",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": VIEWER_CSP,
  };
  if (req.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(await mediaRes.blob(), { status: 200, headers });
}

async function handlePdfViewerRoute(req: Request, pathname: string): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const relative = pathname.replace(/^\/pdf-viewer\/?/, "");

  if (relative === "source") {
    return await handlePdfMediaSource(req);
  }

  if (relative && !relative.startsWith("?")) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": VIEWER_CSP,
  };

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(generatePdfViewerPage(), { status: 200, headers });
}

// Register /pdf-viewer/* route via the same global used above
(function() {
  const __regPdf = (globalThis as any).__piclaw_registerRoute;
  if (typeof __regPdf === "function") {
    __regPdf(ROUTE_PREFIX, handlePdfViewerRoute);
  } else {
    console.warn("[office-viewer] WARNING: __piclaw_registerRoute not available — PDF viewer route NOT registered.");
  }
})();
