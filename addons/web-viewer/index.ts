/**
 * web-viewer/index.ts — Combined HTML, image, and video viewer addon for Piclaw.
 *
 * Registers three viewer routes via __piclaw_registerRoute:
 *   /html-viewer   — sandboxed HTML preview
 *   /image-viewer  — workspace and media image viewer
 *   /video-viewer  — workspace video player
 */

import { resolve, dirname } from "node:path";

const EXT_DIR = typeof import.meta.dir === "string"
  ? import.meta.dir
  : dirname(new URL(import.meta.url).pathname);

function reg(prefix: string, handler: (req: Request, pathname: string) => Response | null): void {
  const fn = (globalThis as any).__piclaw_registerRoute;
  if (typeof fn === "function") fn(prefix, handler, EXT_DIR);
  else console.warn(`[web-viewer] __piclaw_registerRoute unavailable — ${prefix} not registered.`);
}

// ── HTML viewer ──────────────────────────────────────────────────────────────
/**
 * html-viewer-route.ts — Authenticated HTML preview route.
 *
 * Serves an iframe-based HTML file viewer at /html-viewer/?path=...
 * Renders workspace HTML files in a sandboxed iframe with same-origin
 * script access (so vendored libs like Babylon.js/ECharts/D3 work).
 */


const HTML_ROUTE_PREFIX = "/html-viewer";

const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export function generateHtmlViewerPage(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>HTML Preview</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: #0f1117; font-family: Inter, system-ui, sans-serif; height: 100vh; display: flex; flex-direction: column; }
  #toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #1a1d28; border-bottom: 1px solid rgba(148,163,184,.15); flex-shrink: 0; }
  #toolbar .filename { color: #e2e8f0; font-size: 13px; font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #toolbar button { appearance: none; border: 0; cursor: pointer; font: 12px/1 Inter, system-ui, sans-serif; border-radius: 6px; padding: 6px 12px; color: #cbd5e1; background: rgba(148,163,184,.12); }
  #toolbar button:hover { background: rgba(148,163,184,.2); }
  #toolbar .sep { width: 1px; height: 20px; background: rgba(148,163,184,.15); }
  #frame { flex: 1; border: 0; width: 100%; background: white; }
  .empty { color: #94a3b8; font-size: 14px; padding: 24px; text-align: center; }
</style>
</head>
<body>
  <div id="toolbar">
    <span class="filename" id="filename">HTML Preview</span>
    <button id="btnSource" title="View source in editor">View Source</button>
    <div class="sep"></div>
    <button id="btnRefresh" title="Reload">↻ Refresh</button>
    <button id="btnNewTab" title="Open in new tab">↗ New Tab</button>
  </div>
  <!-- allow-same-origin is critical for dynamic HTML widgets/previews that load same-origin vendored/workspace assets. -->
  <iframe id="frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
  <script>
  (function() {
    var params = new URLSearchParams(location.search);
    var filePath = params.get('path') || '';
    if (!filePath) {
      document.getElementById('frame').style.display = 'none';
      document.body.innerHTML += '<div class="empty">Missing <code>?path=...</code> query parameter.</div>';
      return;
    }
    var fileName = filePath.split('/').pop() || 'index.html';
    document.getElementById('filename').textContent = fileName;
    document.title = fileName + ' — HTML Preview';

    var rawUrl = '/workspace/raw?path=' + encodeURIComponent(filePath);
    var frame = document.getElementById('frame');
    frame.src = rawUrl;

    document.getElementById('btnRefresh').addEventListener('click', function() {
      frame.src = rawUrl + '&_t=' + Date.now();
    });

    document.getElementById('btnNewTab').addEventListener('click', function() {
      window.open(rawUrl, '_blank');
    });

    document.getElementById('btnSource').addEventListener('click', function() {
      // Navigate the parent to the editor view for this file
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'piclaw:open-file', path: filePath, mode: 'edit' }, '*');
      } else {
        window.location.href = '/workspace/edit?path=' + encodeURIComponent(filePath);
      }
    });
  })();
  </script>
</body>
</html>`;
}

export function handleRoute(req: Request, pathname: string): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const relative = pathname.replace(/^\/html-viewer\/?/, "");
  if (relative && !relative.startsWith("?")) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": HTML_CSP,
  };

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(generateHtmlViewerPage(), { status: 200, headers });
}

reg(HTML_ROUTE_PREFIX, handleRoute);

// ── Image viewer ─────────────────────────────────────────────────────────────
/**
 * image-viewer-route.ts — Lightweight authenticated image viewer route.
 *
 * Serves a same-origin zoomable image viewer that loads workspace images via
 * /workspace/raw.
 */


const IMG_ROUTE_PREFIX = "/image-viewer";
const IMAGE_CSP = [
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

function generateImageViewerPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Image Viewer</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: #1e1e1e;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .stage {
    width: 100%;
    height: 100%;
    overflow: auto;
    background-image:
      linear-gradient(45deg, rgba(128,128,128,0.08) 25%, transparent 25%),
      linear-gradient(-45deg, rgba(128,128,128,0.08) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.08) 75%),
      linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.08) 75%);
    background-size: 20px 20px;
    background-position: 0 0, 0 10px, 10px -10px, -10px 0;
  }
  .inner {
    min-width: 100%; min-height: 100%;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  img {
    max-width: none; max-height: none;
    transform-origin: center center;
    border-radius: 2px;
    background: white;
  }
  /* Hover toolbar — top-right */
  #toolbar-trigger { position: fixed; top: 0; right: 0; width: 140px; height: 24px; z-index: 99; }
  #toolbar {
    position: fixed; top: 0; right: 0; z-index: 100;
    display: flex; gap: 4px; padding: 6px 8px;
    background: rgba(30,30,30,0.92); border-bottom-left-radius: 6px;
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    opacity: 0; transition: opacity 0.2s;
  }
  #toolbar-trigger:hover + #toolbar, #toolbar:hover { opacity: 1; }
  #toolbar button {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 28px; height: 24px; padding: 0 6px;
    border: none; border-radius: 3px; background: rgba(255,255,255,0.08);
    color: #ccc; font: 12px system-ui, sans-serif; cursor: pointer;
  }
  #toolbar button:hover { background: rgba(255,255,255,0.15); color: #fff; }
  #toolbar .zoom-label { font-size: 11px; color: #999; min-width: 36px; text-align: center; line-height: 24px; }
  .empty {
    display: flex; width: 100%; height: 100%;
    align-items: center; justify-content: center;
    color: #888; font-size: 14px; padding: 24px; text-align: center;
  }
</style>
</head>
<body>
<div id="toolbar-trigger"></div>
<div id="toolbar">
  <button id="zoomOut">−</button>
  <span class="zoom-label" id="zoomLabel">100%</span>
  <button id="zoomIn">+</button>
  <button id="zoomReset">1:1</button>
</div>
<div id="stage" class="stage"><div class="inner"></div></div>
<script>
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var path = params.get('path') || '';
  var stageEl = document.getElementById('stage');

  if (!path) {
    document.body.innerHTML = '<div class="empty">Missing <code>?path=...</code> query parameter.</div>';
    return;
  }

  var fileName = path.split('/').pop() || 'image';
  document.title = fileName + ' · Image Viewer';

  var rawUrl = '/workspace/raw?path=' + encodeURIComponent(path);
  var scale = 1;
  var img = document.createElement('img');
  img.alt = fileName;
  img.src = rawUrl;

  var zoomLabel = document.getElementById('zoomLabel');
  function applyScale() {
    img.style.transform = 'scale(' + scale + ')';
    zoomLabel.textContent = Math.round(scale * 100) + '%';
  }
  function clamp(v) { return Math.max(0.1, Math.min(8, v)); }

  document.getElementById('zoomOut').addEventListener('click', function () { scale = clamp(scale / 1.25); applyScale(); });
  document.getElementById('zoomIn').addEventListener('click', function () { scale = clamp(scale * 1.25); applyScale(); });
  document.getElementById('zoomReset').addEventListener('click', function () { scale = 1; applyScale(); });
  stageEl.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    scale = clamp(scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
    applyScale();
  }, { passive: false });

  img.addEventListener('error', function () {
    stageEl.innerHTML = '<div class="inner"><div class="empty">Failed to load image.</div></div>';
  });

  var inner = stageEl.querySelector('.inner');
  inner.appendChild(img);
  applyScale();
})();
</script>
</body>
</html>`;
}

function handleImageViewerRoute(req: Request, pathname: string): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const relative = pathname.replace(/^\/image-viewer\/?/, "");
  if (relative && !relative.startsWith("?")) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": IMAGE_CSP,
  };

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(generateImageViewerPage(), { status: 200, headers });
}

reg(IMG_ROUTE_PREFIX, handleImageViewerRoute);

// ── Video viewer ─────────────────────────────────────────────────────────────
/**
 * video-viewer-route.ts — Lightweight authenticated video viewer route.
 *
 * Serves a same-origin HTML5 video player that loads workspace video files via
 * /workspace/raw.
 */


const VID_ROUTE_PREFIX = "/video-viewer";
const VIDEO_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function generateVideoViewerPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Video Viewer</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: #111;
    color: #ddd;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .shell {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .stage {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
    padding: 10px;
  }
  video {
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    background: #000;
    border-radius: 4px;
  }
  .meta {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid rgba(255,255,255,0.08);
    background: #161616;
    font-size: 12px;
  }
  .meta .name {
    color: #cfcfcf;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .meta .tip {
    color: #888;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .empty {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
    color: #888;
    font-size: 14px;
  }
</style>
</head>
<body>
<div id="root" class="shell"></div>
<script>
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var path = String(params.get('path') || '').trim();
  var root = document.getElementById('root');

  function esc(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  if (!path) {
    root.innerHTML = '<div class="empty">Missing <code>?path=...</code> query parameter.</div>';
    return;
  }

  var fileName = path.split('/').pop() || 'video.mp4';
  var sourceUrl = '/workspace/raw?path=' + encodeURIComponent(path);

  root.innerHTML =
    '<div class="stage">' +
      '<video controls playsinline preload="metadata" src="' + esc(sourceUrl) + '"></video>' +
    '</div>' +
    '<div class="meta">' +
      '<span class="name" title="' + esc(path) + '">' + esc(fileName) + '</span>' +
      '<span class="tip">Space/K to play-pause • ←/→ seek</span>' +
    '</div>';

  var video = root.querySelector('video');
  if (!video) return;

  video.addEventListener('error', function () {
    root.innerHTML = '<div class="empty">Failed to load video.</div>';
  });

  document.addEventListener('keydown', function (event) {
    if (!video) return;
    if (event.key === ' ' || event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (video.paused) video.play().catch(function () { /* expected: autoplay can be blocked by browser media policies. */ });
      else video.pause();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - 5);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
      return;
    }
  });
})();
</script>
</body>
</html>`;
}

function handleVideoViewerRoute(req: Request, pathname: string): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const relative = pathname.replace(/^\/video-viewer\/?/, "");
  if (relative && !relative.startsWith("?")) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": VIDEO_CSP,
  };

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(generateVideoViewerPage(), { status: 200, headers });
}

reg(VID_ROUTE_PREFIX, handleVideoViewerRoute);

export default function webViewerAddon(_pi: any): void {}
