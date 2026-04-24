// @ts-nocheck
/**
 * eml-viewer.ts — WebPaneExtension for .eml email message files.
 *
 * Parses RFC 822 email headers and renders the message body.
 * Supports plain text and HTML content types.
 */

// Types inlined for standalone use

const EML_PATTERN = /\.eml$/i;

function parseEml(raw) {
    const headerEnd = raw.indexOf('\r\n\r\n');
    const headerEndLf = raw.indexOf('\n\n');
    const splitPos = headerEnd >= 0 ? headerEnd : headerEndLf;
    const headerSep = headerEnd >= 0 ? '\r\n\r\n' : '\n\n';

    if (splitPos < 0) return { headers: {}, body: raw, contentType: 'text/plain' };

    const headerBlock = raw.slice(0, splitPos);
    let body = raw.slice(splitPos + headerSep.length);

    // Unfold continuation lines
    const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
    const headers = {};
    for (const line of unfolded.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers[key] = value;
    }

    const contentType = (headers['content-type'] || 'text/plain').split(';')[0].trim().toLowerCase();
    const transferEncoding = (headers['content-transfer-encoding'] || '').toLowerCase().trim();

    // Decode quoted-printable
    if (transferEncoding === 'quoted-printable') {
        body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
            String.fromCharCode(parseInt(hex, 16))
        );
    }

    // Decode base64
    if (transferEncoding === 'base64') {
        try { body = atob(body.replace(/\s/g, '')); } catch {}
    }

    // Handle multipart
    if (contentType.startsWith('multipart/')) {
        const boundaryMatch = (headers['content-type'] || '').match(/boundary="?([^";\s]+)"?/i);
        if (boundaryMatch) {
            const boundary = boundaryMatch[1];
            const parts = body.split(`--${boundary}`).filter(p => p.trim() && !p.trim().startsWith('--'));
            let htmlPart = null;
            let textPart = null;
            for (const part of parts) {
                const partSplit = part.indexOf('\r\n\r\n') >= 0 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
                if (partSplit < 0) continue;
                const partHeaders = part.slice(0, partSplit).toLowerCase();
                const partBody = part.slice(partSplit + (part.indexOf('\r\n\r\n') >= 0 ? 4 : 2));
                if (partHeaders.includes('text/html')) htmlPart = partBody;
                else if (partHeaders.includes('text/plain')) textPart = partBody;
            }
            if (htmlPart) return { headers, body: htmlPart, contentType: 'text/html' };
            if (textPart) return { headers, body: textPart, contentType: 'text/plain' };
        }
    }

    return { headers, body, contentType };
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderEml(container, content) {
    const { headers, body, contentType } = parseEml(content);

    const from = headers['from'] || '';
    const to = headers['to'] || '';
    const cc = headers['cc'] || '';
    const subject = headers['subject'] || '(no subject)';
    const date = headers['date'] || '';

    const headerHtml = `
        <div class="eml-viewer-header">
            <div class="eml-viewer-subject">${escapeHtml(subject)}</div>
            <div class="eml-viewer-meta">
                ${from ? `<div><strong>From:</strong> ${escapeHtml(from)}</div>` : ''}
                ${to ? `<div><strong>To:</strong> ${escapeHtml(to)}</div>` : ''}
                ${cc ? `<div><strong>Cc:</strong> ${escapeHtml(cc)}</div>` : ''}
                ${date ? `<div><strong>Date:</strong> ${escapeHtml(date)}</div>` : ''}
            </div>
        </div>
    `;

    let bodyHtml;
    if (contentType === 'text/html') {
        bodyHtml = `<div class="eml-viewer-body"><iframe class="eml-viewer-iframe" sandbox="allow-same-origin" srcdoc="${escapeHtml(body)}"></iframe></div>`;
    } else {
        bodyHtml = `<div class="eml-viewer-body"><pre class="eml-viewer-text">${escapeHtml(body)}</pre></div>`;
    }

    container.innerHTML = `
        <style>
            .eml-viewer { display: flex; flex-direction: column; height: 100%; font-family: var(--font-sans, system-ui, sans-serif); color: var(--text-primary); background: var(--bg-primary); }
            .eml-viewer-header { padding: 16px 20px; border-bottom: 1px solid var(--border-color, #e0e0e0); flex-shrink: 0; }
            .eml-viewer-subject { font-size: 1.2em; font-weight: 700; margin-bottom: 8px; }
            .eml-viewer-meta { font-size: 0.88em; color: var(--text-secondary); display: flex; flex-direction: column; gap: 2px; }
            .eml-viewer-meta strong { color: var(--text-primary); min-width: 50px; display: inline-block; }
            .eml-viewer-body { flex: 1; overflow: auto; min-height: 0; }
            .eml-viewer-iframe { width: 100%; height: 100%; border: none; background: white; }
            .eml-viewer-text { padding: 16px 20px; margin: 0; font-size: 0.9em; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
        </style>
        <div class="eml-viewer">${headerHtml}${bodyHtml}</div>
    `;
}

export const emlViewerExtension: WebPaneExtension = {
    id: 'eml-viewer',
    label: 'Email Viewer',
    icon: '📧',
    capabilities: ['readonly'] as PaneCapability[],
    placement: 'tabs',

    canHandle(context) {
        if (!context.path) return false;
        return EML_PATTERN.test(context.path) ? 10 : false;
    },

    mount(container, context) {
        const content = context.content || '';
        renderEml(container, content);

        return {
            dispose() { container.innerHTML = ''; },
            update(ctx) {
                if (ctx.content !== undefined) renderEml(container, ctx.content || '');
            },
        };
    },
};
