/**
 * Browser-side PDF viewer pane for piclaw-addon-office-viewer.
 *
 * Registers a web pane extension for .pdf files using browser-native rendering.
 * Zero chrome — no pdf.js; falls back to an open-in-new-tab link when embedding fails.
 */

const PDF_EXTENSIONS = /\.pdf$/i;

const webApi = globalThis.__piclaw_web;

if (webApi && typeof webApi.registerPane === 'function') {
  webApi.registerPane({
    id: 'pdf-viewer',
    priority: 10,
    canHandle(context) {
      const path = context?.path || context?.filePath || '';
      return PDF_EXTENSIONS.test(path) ? 10 : 0;
    },
    mount(container, context) {
      const filePath = context?.path || context?.filePath || '';
      const name = filePath.split('/').pop() || 'document.pdf';
      const viewerUrl = `/pdf-viewer/?path=${encodeURIComponent(filePath)}&name=${encodeURIComponent(name)}`;

      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;background:var(--bg-primary,#1e1e1e);';
      wrapper.innerHTML = `
        <div style="flex:0 0 auto;padding:6px 12px;background:var(--bg-secondary,#252526);border-bottom:1px solid var(--border-color,#333);display:flex;align-items:center;gap:8px;">
          <span style="font-size:12px;color:var(--text-secondary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</span>
          <button id="pdf-open-tab" style="margin-left:auto;padding:4px 10px;background:var(--accent-color,#1d9bf0);color:var(--accent-contrast-text,#fff);border:none;border-radius:4px;font-size:11px;cursor:pointer;">Open in new tab</button>
        </div>
        <iframe src="${viewerUrl}" style="flex:1;border:none;width:100%;height:100%;" allow="same-origin" title="${name}"></iframe>
      `;
      container.appendChild(wrapper);

      const btn = wrapper.querySelector('#pdf-open-tab');
      if (btn) btn.addEventListener('click', () => window.open(viewerUrl, '_blank'));

      return {
        dispose() { wrapper.remove(); },
        resize() {},
        focus() {},
        setContent() {},
      };
    },
  });
}
