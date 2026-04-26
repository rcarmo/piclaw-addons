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
      :root { color-scheme: dark; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { height: 100%; background: #0d1117; color: #c9d1d9; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      body { padding: 14px 18px; overflow: auto; }
      .hdr { color: #8b949e; }
      .hdr b { color: #c9d1d9; font-weight: 600; }
      hr { border: none; border-top: 1px solid rgba(139,148,158,0.2); margin: 10px 0; }
      .body { white-space: pre-wrap; word-break: break-word; }
      .html-body { line-height: 1.5; word-break: break-word; }
      .html-body img, .html-body table { max-width: 100%; }
      .html-body pre { white-space: pre-wrap; word-break: break-word; }
      .err { color: #f85149; padding: 20px 0; }
    </style>
  </head>
  <body>
    <div id="out">Loading…</div>
    <script>
      const params = new URLSearchParams(window.location.search);
      const mediaId = params.get('media');
      const filename = params.get('name') || (mediaId ? ('attachment-' + mediaId + '.eml') : 'email.eml');

      const out = document.getElementById('out');

      document.title = filename + ' — Email';

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
            .map(part => parseMimeEntity(part, level + 1));
          return { headers, contentType: contentType.type, body: '', rawBody: null, parts };
        }

        const rawBody = split.body;
        const decodedBody = decodeTransferEncodedBody(rawBody, transferEncoding, contentType.params.charset);
        return {
          headers,
          contentType: contentType.type,
          body: decodedBody,
          rawBody: (String(transferEncoding || '').trim().toLowerCase() === 'base64') ? String(rawBody || '').replace(/\s+/g, '') : null,
          parts: [],
        };
      }

      function collectInlineImages(entity, map) {
        if (!entity) return map;
        if (Array.isArray(entity.parts) && entity.parts.length > 0) {
          for (const part of entity.parts) collectInlineImages(part, map);
          return map;
        }
        if (!entity.contentType || !entity.contentType.startsWith('image/')) return map;
        const cid = String(entity.headers?.['content-id'] || '').replace(/^<|>$/g, '').trim();
        if (!cid) return map;
        const ct = parseContentType(entity.headers?.['content-type']);
        const mimeType = ct.type || 'image/png';
        if (entity.rawBody) {
          map[cid] = 'data:' + mimeType + ';base64,' + entity.rawBody;
        }
        return map;
      }

      function replaceCidReferences(html, cidMap) {
        if (!html || !cidMap) return html;
        return String(html).replace(/(["'])cid:([^"'\s]+)(["'])/gi, function(match, q1, cid, q2) {
          const dataUri = cidMap[cid];
          return dataUri ? (q1 + dataUri + q2) : match;
        });
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
        return ['from','to','cc','date','subject'].filter(function(k){return headers[k];}).map(function(k){
          return '<span class="hdr">' + k.charAt(0).toUpperCase() + k.slice(1) + ':</span> <b>' + escapeHtml(headers[k]) + '</b>';
        }).join('\n');
      }

      function renderPlain(body) {
        return '<div class="body">' + escapeHtml(body || '') + '</div>';
      }

      function renderHtml(body) {
        return '<div class="html-body">' + sanitizeHtmlBody(body || '') + '</div>';
      }

      function renderError(message) {
        return '<div class="err">' + escapeHtml(message || 'Unknown error') + '</div>';
      }

      async function load() {
        if (!mediaId || !/^\d+$/.test(mediaId)) {
          out.innerHTML = renderError('Missing or invalid media id.');
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
          const cidMap = collectInlineImages(root, {});
          const meta = renderMeta(headers);
          if (display && display.contentType === 'text/html') {
            const htmlWithImages = replaceCidReferences(display.body || '', cidMap);
            out.innerHTML = meta + '\n<hr>' + renderHtml(htmlWithImages);
            return;
          }
          const text = display && typeof display.body === 'string' ? display.body : raw;
          out.innerHTML = meta + '\n<hr>\n' + renderPlain(text);
        } catch (error) {
          out.innerHTML = renderError(error && error.message ? error.message : String(error || 'Unknown error'));
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
