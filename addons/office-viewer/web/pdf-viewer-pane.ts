/**
 * pdf-viewer-pane.ts — WebPaneExtension for PDF viewing.
 *
 * In preview mode (workspace browser): shows a launch card with "Open in Tab" button.
 * In edit/tab mode: loads a same-origin PDF wrapper page that embeds the raw PDF.
 * Zero chrome — no pdf.js; falls back to an open-in-new-tab link when embedding fails.
 */


const PDF_EXTENSIONS = /\.pdf$/i;

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Preview card (workspace browser) ────────────────────────────

class PdfPreviewCard implements PaneInstance {
    private container: HTMLElement;
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context.path || '';
        const name = filePath.split('/').pop() || 'document.pdf';

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg-primary,#1a1a1a);';
        wrapper.innerHTML = `
            <div style="text-align:center;max-width:360px;padding:24px;">
                <div style="font-size:56px;margin-bottom:12px;">📄</div>
                <div style="font-size:14px;font-weight:600;color:var(--text-primary,#e0e0e0);margin-bottom:4px;word-break:break-word;">${esc(name)}</div>
                <div style="font-size:11px;color:var(--text-secondary,#888);margin-bottom:20px;">PDF Document</div>
                <button id="pdf-open-tab" style="padding:8px 20px;background:var(--accent-color,#1d9bf0);color:var(--accent-contrast-text,#fff);
                    border:none;border-radius:5px;font-size:13px;font-weight:500;cursor:pointer;
                    transition:background 0.15s;"
                    onmouseenter="this.style.background='var(--accent-hover,#1a8cd8)'"
                    onmouseleave="this.style.background='var(--accent-color,#1d9bf0)'">
                    Open in Tab
                </button>
            </div>
        `;
        container.appendChild(wrapper);

        const btn = wrapper.querySelector('#pdf-open-tab') as HTMLButtonElement;
        if (btn) {
            btn.addEventListener('click', () => {
                const evt = new CustomEvent('pdf-viewer:open-tab', {
                    bubbles: true,
                    detail: { path: filePath },
                });
                container.dispatchEvent(evt);
            });
        }
    }

    getContent(): string | undefined { return undefined; }
    isDirty(): boolean { return false; }
    focus(): void {}
    resize(): void {}
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.container.innerHTML = '';
    }
}

// ── Full viewer (editor tab) ────────────────────────────────────

class PdfViewerInstance implements PaneInstance {
    private container: HTMLElement;
    private iframe: HTMLIFrameElement | null = null;
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context.path || '';
        const viewerUrl = `/pdf-viewer/?path=${encodeURIComponent(filePath)}`;

        this.iframe = document.createElement('iframe');
        this.iframe.src = viewerUrl;
        this.iframe.style.cssText = 'width:100%;height:100%;border:none;background:#1e1e1e;';
        container.appendChild(this.iframe);
    }

    getContent(): string | undefined { return undefined; }
    isDirty(): boolean { return false; }
    focus(): void { this.iframe?.focus(); }
    resize(): void {}
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.iframe) {
            this.iframe.src = 'about:blank';
            this.iframe = null;
        }
        this.container.innerHTML = '';
    }
}

// ── Extension ───────────────────────────────────────────────────

export const pdfViewerPaneExtension: WebPaneExtension = {
    id: 'pdf-viewer',
    label: 'PDF Viewer',
    icon: 'file-text',
    capabilities: ['readonly', 'preview'] as PaneCapability[],
    placement: 'tabs',

    canHandle(context: PaneContext): boolean | number {
        const path = context?.path || '';
        if (!PDF_EXTENSIONS.test(path)) return false;
        return 52;
    },

    mount(container: HTMLElement, context: PaneContext): PaneInstance {
        if (context?.mode === 'view') {
            return new PdfPreviewCard(container, context);
        }
        return new PdfViewerInstance(container, context);
    },
};

// Register with piclaw's addon web API
const __webApiPDF = (globalThis as any).__piclaw_web;
if (__webApiPDF && typeof __webApiPDF.registerPane === 'function') {
  __webApiPDF.registerPane(pdfViewerPaneExtension);
}
