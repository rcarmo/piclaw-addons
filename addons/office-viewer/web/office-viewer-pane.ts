/**
 * office-viewer-pane.ts — WebPaneExtension for viewing Office documents.
 *
 * Uses lightweight client-side JS libraries (docx-preview, SheetJS, PptxViewJS)
 * served through the /office-viewer extension route. No WASM, no HTTPS requirement.
 *
 * In preview mode (workspace browser): shows a launch card with "Open in Tab" button.
 * In edit/tab mode: loads the viewer in an iframe.
 */


const OFFICE_EXTENSIONS = new Set([
    '.docx', '.doc', '.odt', '.rtf',
    '.xlsx', '.xls', '.ods', '.csv',
    '.pptx', '.ppt', '.odp',
]);

const FORMAT_LABELS: Record<string, string> = {
    '.docx': 'Word Document', '.doc': 'Word (Legacy)', '.odt': 'OpenDocument Text', '.rtf': 'Rich Text',
    '.xlsx': 'Excel Spreadsheet', '.xls': 'Excel (Legacy)', '.ods': 'OpenDocument Spreadsheet', '.csv': 'CSV Data',
    '.pptx': 'PowerPoint', '.ppt': 'PowerPoint (Legacy)', '.odp': 'OpenDocument Presentation',
};

const FORMAT_ICONS: Record<string, string> = {
    '.docx': '📝', '.doc': '📝', '.odt': '📝', '.rtf': '📝',
    '.xlsx': '📊', '.xls': '📊', '.ods': '📊', '.csv': '📊',
    '.pptx': '📽️', '.ppt': '📽️', '.odp': '📽️',
};

function getExtension(filePath?: string): string {
    if (!filePath) return '';
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot < 0) return '';
    return filePath.slice(lastDot).toLowerCase();
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Preview card (workspace browser) ────────────────────────────

class OfficePreviewCard implements PaneInstance {
    private container: HTMLElement;
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context.path || '';
        const name = filePath.split('/').pop() || 'document';
        const ext = getExtension(filePath);
        const icon = FORMAT_ICONS[ext] || '📄';
        const label = FORMAT_LABELS[ext] || 'Office Document';

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg-primary,#1a1a1a);';
        wrapper.innerHTML = `
            <div style="text-align:center;max-width:360px;padding:24px;">
                <div style="font-size:56px;margin-bottom:12px;">${icon}</div>
                <div style="font-size:14px;font-weight:600;color:var(--text-primary,#e0e0e0);margin-bottom:4px;word-break:break-word;">${esc(name)}</div>
                <div style="font-size:11px;color:var(--text-secondary,#888);margin-bottom:20px;">${esc(label)}</div>
                <button id="ov-open-tab" style="padding:8px 20px;background:var(--accent-color,#1d9bf0);color:var(--accent-contrast-text,#fff);
                    border:none;border-radius:5px;font-size:13px;font-weight:500;cursor:pointer;
                    transition:background 0.15s;"
                    onmouseenter="this.style.background='var(--accent-hover,#1a8cd8)'"
                    onmouseleave="this.style.background='var(--accent-color,#1d9bf0)'">
                    Open in Tab
                </button>
            </div>
        `;
        container.appendChild(wrapper);

        const btn = wrapper.querySelector('#ov-open-tab') as HTMLButtonElement;
        if (btn) {
            btn.addEventListener('click', () => {
                const evt = new CustomEvent('office-viewer:open-tab', {
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

class OfficeViewerInstance implements PaneInstance {
    private container: HTMLElement;
    private iframe: HTMLIFrameElement | null = null;
    private disposed = false;

    constructor(container: HTMLElement, context: PaneContext) {
        this.container = container;
        const filePath = context.path || '';
        const name = filePath.split('/').pop() || 'document';

        const rawUrl = `/workspace/raw?path=${encodeURIComponent(filePath)}`;
        const viewerUrl = `/office-viewer/?url=${encodeURIComponent(rawUrl)}&name=${encodeURIComponent(name)}`;

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

export const officeViewerPaneExtension: WebPaneExtension = {
    id: 'office-viewer',
    label: 'Office Viewer',
    icon: 'file-text',
    capabilities: ['readonly', 'preview'] as PaneCapability[],
    placement: 'tabs',

    canHandle(context: PaneContext): boolean | number {
        const ext = getExtension(context?.path);
        if (!ext || !OFFICE_EXTENSIONS.has(ext)) return false;
        return 50;
    },

    mount(container: HTMLElement, context: PaneContext): PaneInstance {
        if (context?.mode === 'view') {
            return new OfficePreviewCard(container, context);
        }
        return new OfficeViewerInstance(container, context);
    },
};

// Register with piclaw's addon web API
const __webApiOV = (globalThis as any).__piclaw_web;
if (__webApiOV && typeof __webApiOV.registerPane === 'function') {
  __webApiOV.registerPane(officeViewerPaneExtension);
}
