/**
 * eml-viewer/index.ts — Attachment preview route for .eml email messages.
 *
 * Registers an HTTP route at /eml-viewer/* that serves a self-contained
 * browser preview for message/rfc822 attachments. The page fetches the media
 * payload from piclaw's authenticated /media/:id endpoint and renders the
 * message body in a read-only viewer.
 */

const ROUTE_PREFIX = "/eml-viewer";
const EXT_DIR = typeof import.meta !== "undefined" && import.meta.dir ? import.meta.dir : process.cwd();
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function buildViewerHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Email preview</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1020;
        --surface: rgba(15, 23, 42, 0.92);
        --surface-2: rgba(15, 23, 42, 0.72);
        --border: rgba(148, 163, 184, 0.22);
        --text: #e5eefc;
        --muted: #9fb0cf;
        --accent: #7dd3fc;
        --accent-2: #38bdf8;
        --shadow: 0 18px 40px rgba(2, 8, 23, 0.34);
      }

      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--text); font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { overflow: auto; }
      .shell { padding: 16px 20px; }
      .meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 16px;
        margin-bottom: 12px;
        font-size: 13px;
        line-height: 1.45;
      }
      .meta-label {
        color: var(--muted);
        font-weight: 600;
        flex-shrink: 0;
      }
      .meta-value {
        word-break: break-word;
        min-width: 0;
      }
      .divider {
        border: none;
        border-top: 1px solid var(--border);
        margin: 12px 0;
      }
      .state {
        min-height: 320px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 12px;
        padding: 28px;
        text-align: center;
        color: var(--muted);
      }
      .spinner {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 3px solid rgba(148, 163, 184, 0.18);
        border-top-color: var(--accent-2);
        animation: spin 0.9s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .plain {
        margin: 0;
        padding: 0;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.6;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
      }
      .html-frame {
        width: 100%;
        min-height: 65vh;
        border: 0;
        background: white;
      }
      .warning {
        padding: 8px 12px;
        margin-bottom: 8px;
        border-radius: 6px;
        background: rgba(14, 165, 233, 0.08);
        color: var(--muted);
        font-size: 12px;
      }
      a { color: var(--accent); }
      @media (max-width: 720px) {
        .shell { padding: 12px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div id="meta"></div>
      <hr class="divider">
      <div id="content">
        <div class="state">
          <div class="spinner" aria-hidden="true"></div>
          <div>Loading email…</div>
        </div>
      </div>
    </div>
    <script>
      const params = new URLSearchParams(window.location.search);
      const mediaId = params.get('media');
      const filename = params.get('name') || (mediaId ? ('attachment-' + mediaId + '.eml') : 'email.eml');

      const metaEl = document.getElementById('meta');
      const contentEl = document.getElementById('content');

      document.title = filename + ' — Email preview';

      function escapeHtml(value) {
        return String(value == null ? '' : value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\"/g, '&quot;');
      }

      function decodeHeaderWords(value) {
        return String(value || '').replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, function (_, charset, encoding, encoded) {
          try {
            if (String(encoding).toUpperCase() === 'B') {
              const binary = atob(encoded.replace(/\s+/g, ''));
              const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
              return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(bytes);
            }
            const qp = encoded.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, function (__ , hex) {
              return String.fromCharCode(parseInt(hex, 16));
            });
            const bytes = Uint8Array.from(qp, ch => ch.charCodeAt(0));
            return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(bytes);
          } catch {
            return encoded;
          }
        });
      }

      function parseHeaderBlock(headerBlock) {
        const headers = {};
        const unfolded = String(headerBlock || '').replace(/\r?\n[ \t]+/g, ' ');
        for (const line of unfolded.split(/\r?\n/)) {
          const colon = line.indexOf(':');
          if (colon < 0) continue;
          const key = line.slice(0, colon).trim().toLowerCase();
          const value = decodeHeaderWords(line.slice(colon + 1).trim());
          if (!key) continue;
          headers[key] = headers[key] ? String(headers[key]) + ', ' + value : value;
        }
        return headers;
      }

      function splitMimeEntity(raw) {
        const headerEndCrLf = raw.indexOf('\r\n\r\n');
        const headerEndLf = raw.indexOf('\n\n');
        const splitPos = headerEndCrLf >= 0 ? headerEndCrLf : headerEndLf;
        const separatorLength = headerEndCrLf >= 0 ? 4 : 2;
        if (splitPos < 0) {
          return { headerBlock: '', body: raw };
        }
        return {
          headerBlock: raw.slice(0, splitPos),
          body: raw.slice(splitPos + separatorLength),
        };
      }

      function parseContentType(value) {
        const parts = String(value || 'text/plain').split(';');
        const type = (parts.shift() || 'text/plain').trim().toLowerCase();
        const params = {};
        for (const part of parts) {
          const eq = part.indexOf('=');
          if (eq < 0) continue;
          const key = part.slice(0, eq).trim().toLowerCase();
          const raw = part.slice(eq + 1).trim();
          params[key] = raw.replace(/^\"|\"$/g, '');
        }
        return { type, params };
      }

      function decodeQuotedPrintableToBytes(value) {
        const normalized = String(value || '').replace(/=(\r?\n)/g, '');
        const bytes = [];
        for (let i = 0; i < normalized.length; i += 1) {
          const ch = normalized[i];
          if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(i + 1, i + 3))) {
            bytes.push(parseInt(normalized.slice(i + 1, i + 3), 16));
            i += 2;
            continue;
          }
          bytes.push(ch.charCodeAt(0) & 0xff);
        }
        return new Uint8Array(bytes);
      }

      function decodeTransferEncodedBody(body, transferEncoding, charset) {
        const encoding = String(transferEncoding || '').trim().toLowerCase();
        const normalizedCharset = String(charset || 'utf-8').trim().toLowerCase() || 'utf-8';
        try {
          if (encoding === 'base64') {
            const binary = atob(String(body || '').replace(/\s+/g, ''));
            const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
            return new TextDecoder(normalizedCharset, { fatal: false }).decode(bytes);
          }
          if (encoding === 'quoted-printable') {
            return new TextDecoder(normalizedCharset, { fatal: false }).decode(decodeQuotedPrintableToBytes(body));
          }
        } catch {
          return String(body || '');
        }
        return String(body || '');
      }

      function splitMultipartBody(body, boundary) {
        if (!boundary) return [];
        const marker = '--' + boundary;
        return String(body || '')
          .split(marker)
          .map(part => part.replace(/^\r?\n/, '').replace(/\r?\n$/, ''))
          .filter(part => part && part !== '--' && !part.startsWith('--'));
      }

      function isAttachmentPart(headers, contentTypeParams) {
        const disposition = String(headers['content-disposition'] || '').toLowerCase();
        if (disposition.startsWith('attachment')) return true;
        if (contentTypeParams.filename || contentTypeParams.name) return true;
        return false;
      }

      function flattenDisplayParts(entity, into) {
        if (!entity) return into;
        if (Array.isArray(entity.parts) && entity.parts.length > 0) {
          for (const part of entity.parts) flattenDisplayParts(part, into);
          return into;
        }
        if (entity.contentType === 'text/html' || entity.contentType === 'text/plain') {
          into.push(entity);
        }
        return into;
      }

      function parseMimeEntity(raw, depth) {
        const level = Number(depth || 0);
        if (level > 6) {
          return { headers: {}, contentType: 'text/plain', body: String(raw || ''), parts: [] };
        }

        const split = splitMimeEntity(String(raw || ''));
        const headers = parseHeaderBlock(split.headerBlock);
        const contentType = parseContentType(headers['content-type']);
        const transferEncoding = headers['content-transfer-encoding'];

        if (contentType.type.startsWith('multipart/') && contentType.params.boundary) {
          const parts = splitMultipartBody(split.body, contentType.params.boundary)
            .map(part => parseMimeEntity(part, level + 1))
            .filter(part => !isAttachmentPart(part.headers || {}, parseContentType(part.headers?.['content-type']).params || {}));
          return { headers, contentType: contentType.type, body: '', parts };
        }

        return {
          headers,
          contentType: contentType.type,
          body: decodeTransferEncodedBody(split.body, transferEncoding, contentType.params.charset),
          parts: [],
        };
      }

      function chooseDisplayEntity(root) {
        const displayParts = flattenDisplayParts(root, []);
        return displayParts.find(part => part.contentType === 'text/html')
          || displayParts.find(part => part.contentType === 'text/plain')
          || root;
      }

      function sanitizeHtmlBody(html) {
        return String(html || '')
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/<base\b[^>]*>/gi, '')
          .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
          .replace(/(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]+)/gi, '$1="#"');
      }

      function buildSandboxedHtmlDocument(html) {
        const safeBody = sanitizeHtmlBody(html);
        return '<!doctype html><html><head>'
          + '<meta charset="utf-8">'
          + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; media-src data: blob:; style-src \'unsafe-inline\'; font-src data:; frame-src \'none\'; connect-src \'none\'">'
          + '<base target="_blank">'
          + '<style>html,body{margin:0;padding:0;background:#fff;color:#111;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;}body{padding:18px;}img,table{max-width:100%;}pre{white-space:pre-wrap;word-break:break-word;}</style>'
          + '</head><body>' + safeBody + '</body></html>';
      }

      function renderMeta(headers) {
        const entries = [
          ['From', headers.from],
          ['To', headers.to],
          ['Cc', headers.cc],
          ['Date', headers.date],
          ['Subject', headers.subject],
        ].filter(function (e) { return e[1] && e[1] !== '—'; });
        metaEl.innerHTML = entries.map(function (entry) {
          return '<div class="meta-row"><span class="meta-label">' + escapeHtml(entry[0]) + ':</span> <span class="meta-value">' + escapeHtml(entry[1]) + '</span></div>';
        }).join('');
      }

      function renderPlain(body) {
        contentEl.innerHTML = '<pre class="plain">' + escapeHtml(body || '') + '</pre>';
      }

      function renderHtml(body) {
        contentEl.innerHTML = '<div class="warning">HTML email is rendered in a sandboxed nested frame with scripts and network access disabled.</div><iframe class="html-frame" referrerpolicy="no-referrer"></iframe>';
        const frame = contentEl.querySelector('iframe');
        if (!frame) return;
        frame.setAttribute('sandbox', '');
        frame.srcdoc = buildSandboxedHtmlDocument(body || '');
      }

      function renderError(message) {
        contentEl.innerHTML = '<div class="state"><strong>Could not load email preview</strong><div>' + escapeHtml(message || 'Unknown error') + '</div></div>';
      }

      async function load() {
        if (!mediaId || !/^\d+$/.test(mediaId)) {
          renderError('Missing or invalid media id.');
          return;
        }
        try {
          const response = await fetch('/media/' + encodeURIComponent(mediaId));
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const raw = await response.text();
          const root = parseMimeEntity(raw, 0);
          const display = chooseDisplayEntity(root);
          const headers = root.headers || {};
          const subject = headers.subject || '(no subject)';
          document.title = subject + ' — ' + filename;
          renderMeta(headers);
          if (display && display.contentType === 'text/html') {
            renderHtml(display.body || '');
            return;
          }
          renderPlain(display && typeof display.body === 'string' ? display.body : raw);
        } catch (error) {
          renderError(error && error.message ? error.message : String(error || 'Unknown error'));
        }
      }

      load();
    </script>
  </body>
</html>`;
}

export function handleRoute(req: Request, pathname: string): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  if (pathname !== ROUTE_PREFIX && pathname !== `${ROUTE_PREFIX}/`) return null;
  const body = buildViewerHtml();
  return new Response(req.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": HTML_CONTENT_TYPE,
      "Cache-Control": "no-store",
    },
  });
}

export default function emlViewer(pi: any) {
  const registerRoute = (globalThis as any).__piclaw_registerRoute as
    | ((prefix: string, handler: (req: Request, pathname: string) => Response | Promise<Response> | null, extensionPath?: string) => "created" | "updated")
    | undefined;

  if (typeof registerRoute === "function") {
    const registration = registerRoute(ROUTE_PREFIX, handleRoute, EXT_DIR);
    if (registration === "created") {
      console.log(`[eml-viewer] Route registered: ${ROUTE_PREFIX}/*`);
    }
  } else {
    console.warn("[eml-viewer] WARNING: __piclaw_registerRoute not available.");
  }

  void pi;
}
