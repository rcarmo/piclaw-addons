/**
 * Browser-side draw.io integration for piclaw-addon-drawio-editor.
 *
 * Registers:
 * - a web pane extension for .drawio workspace tabs
 * - a standalone tab URL resolver for browsers without pane popout support
 * - an attachment preview definition for read-only .drawio attachments
 */

import type { PaneContext, PaneInstance, PiclawWebApi, WebPaneExtension } from './pane-types.js';

const DRAWIO_EXTENSIONS = /\.drawio(\.xml|\.svg|\.png)?$/i;
const DRAWIO_MIME_TYPES = new Set([
  'application/vnd.jgraph.mxfile',
]);

function escapeHtml(value: unknown): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function isDrawioFile(filePath: unknown): boolean {
  return typeof filePath === 'string' && DRAWIO_EXTENSIONS.test(filePath.trim());
}

export function buildDrawioEditorUrl(filePath: string): string {
  return `/drawio/edit.html?path=${encodeURIComponent(filePath || '')}`;
}

export function buildReadonlyAttachmentUrl(mediaId: number | string, filename?: string): string {
  const safeName = encodeURIComponent(filename || `attachment-${mediaId}.drawio`);
  const safeMediaId = encodeURIComponent(String(mediaId));
  return `/drawio/edit.html?media=${safeMediaId}&name=${safeName}&readonly=1#media=${safeMediaId}&name=${safeName}&readonly=1`;
}

class DrawioPreviewCard implements PaneInstance {
  private container: HTMLElement;
  private disposed: boolean;

  constructor(container: HTMLElement, context: PaneContext) {
    this.container = container;
    this.disposed = false;
    const filePath = context?.path || '';
    const name = filePath.split('/').pop() || 'diagram.drawio';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg-primary,#1a1a1a);';
    wrapper.innerHTML = `
      <div style="text-align:center;max-width:360px;padding:24px;">
        <div style="font-size:56px;margin-bottom:12px;">📐</div>
        <div style="font-size:14px;font-weight:600;color:var(--text-primary,#e0e0e0);margin-bottom:4px;word-break:break-word;">${escapeHtml(name)}</div>
        <div style="font-size:11px;color:var(--text-secondary,#888);margin-bottom:20px;">Draw.io Diagram</div>
        <button id="drawio-open-tab" style="padding:8px 20px;background:var(--accent-color,#1d9bf0);color:var(--accent-contrast-text,#fff);border:none;border-radius:5px;font-size:13px;font-weight:500;cursor:pointer;transition:background 0.15s;">
          Edit in Tab
        </button>
      </div>
    `;
    container.appendChild(wrapper);

    const button = wrapper.querySelector('#drawio-open-tab');
    if (button) {
      button.addEventListener('click', () => {
        container.dispatchEvent(new CustomEvent('pane:open-tab', {
          bubbles: true,
          detail: { path: filePath },
        }));
      });
    }
  }

  getContent() { return undefined; }
  isDirty() { return false; }
  focus() {}
  resize() {}
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.container.innerHTML = '';
  }
}

class DrawioEditorInstance implements PaneInstance {
  private container: HTMLElement;
  private iframe: HTMLIFrameElement | null;
  private disposed: boolean;

  constructor(container: HTMLElement, context: PaneContext) {
    this.container = container;
    this.iframe = document.createElement('iframe');
    this.disposed = false;
    this.iframe.src = buildDrawioEditorUrl(context?.path || '');
    this.iframe.style.cssText = 'width:100%;height:100%;border:none;background:#1e1e1e;';
    this.iframe.setAttribute('title', 'Draw.io editor');
    container.appendChild(this.iframe);
  }

  getContent() { return undefined; }
  isDirty() { return false; }
  focus() { this.iframe?.focus?.(); }
  resize() {}
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.iframe) {
      this.iframe.src = 'about:blank';
      this.iframe = null;
    }
    this.container.innerHTML = '';
  }
}

const webApi = (globalThis as Record<string, unknown>).__piclaw_web as PiclawWebApi | undefined;

export const drawioPaneExtension: WebPaneExtension = {
  id: 'drawio-editor',
  label: 'Draw.io Editor',
  icon: 'git-merge',
  capabilities: ['edit', 'preview'],
  placement: 'tabs',
  canHandle(context: PaneContext): boolean | number {
    if (!isDrawioFile(context?.path)) return false;
    return 60;
  },
  mount(container: HTMLElement, context: PaneContext): PaneInstance {
    if (context?.mode === 'view') {
      return new DrawioPreviewCard(container, context);
    }
    return new DrawioEditorInstance(container, context);
  },
};

if (webApi && typeof webApi.registerPane === 'function') {
  webApi.registerPane(drawioPaneExtension);
}

if (webApi && typeof webApi.registerStandaloneTabUrlResolver === 'function') {
  webApi.registerStandaloneTabUrlResolver((path: string, context = {}) => {
    if (!isDrawioFile(path) || context?.hasPopOutTab) return null;
    return `/drawio/edit?path=${encodeURIComponent(path)}`;
  });
}

if (webApi && typeof webApi.registerAttachmentPreview === 'function') {
  webApi.registerAttachmentPreview({
    id: 'drawio',
    label: 'Draw.io preview (read-only)',
    match(contentType: unknown, filename?: unknown): boolean {
      const normalizedType = typeof contentType === 'string' ? contentType.trim().toLowerCase() : '';
      return isDrawioFile(typeof filename === 'string' ? filename : '') || DRAWIO_MIME_TYPES.has(normalizedType);
    },
    buildFrameUrl(mediaId: number | string, filename?: string): string {
      return buildReadonlyAttachmentUrl(mediaId, filename);
    },
    note: 'Draw.io preview is read-only. Editing tools are disabled in this preview.',
  });
}
