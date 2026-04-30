// @ts-nocheck

import { createFileConflictMonitor } from './file-conflict-monitor.ts';

const KANBAN_EXTENSION = /\.kanban\.md$/i;
const ADDON_ASSET_BASE = '/agent/addons/assets/%40rcarmo%2Fpiclaw-addon-kanban-editor/web/vendor';
const KANBAN_SCRIPT_URL = `${ADDON_ASSET_BASE}/kanban-editor.js?v=0.1.1`;
const KANBAN_STYLES_URL = `${ADDON_ASSET_BASE}/kanban.css?v=0.1.1`;

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isDarkThemeActive() {
  const mode = document.documentElement?.dataset?.theme;
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  try {
    return !!window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  } catch {
    return false;
  }
}

function ensurePreactGlobals() {
  const runtime = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
  if (!runtime) throw new Error('piclaw preact runtime not available');
  const windowAny = window;
  if (!windowAny.preact) {
    windowAny.preact = {
      h: runtime.h,
      render: runtime.render,
      Component: runtime.Component,
      createContext: runtime.createContext,
    };
  }
  if (!windowAny.preactHooks) {
    windowAny.preactHooks = {
      useState: runtime.useState,
      useEffect: runtime.useEffect,
      useCallback: runtime.useCallback,
      useRef: runtime.useRef,
      useMemo: runtime.useMemo,
      useReducer: runtime.useReducer,
      useContext: runtime.useContext,
      useLayoutEffect: runtime.useLayoutEffect,
      useImperativeHandle: runtime.useImperativeHandle,
      useErrorBoundary: runtime.useErrorBoundary,
      useDebugValue: runtime.useDebugValue,
    };
  }
  if (!windowAny.htm) {
    windowAny.htm = { bind: () => runtime.html };
  }
}

function ensureScript(src) {
  const baseSrc = src.split('?')[0];
  const existing = document.querySelector(`script[data-src="${baseSrc}"]`);
  if (existing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.dataset.src = baseSrc;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
}

function ensureStylesheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const el = document.createElement('link');
  el.rel = 'stylesheet';
  el.href = href;
  document.head.appendChild(el);
}

class KanbanPreviewCard {
  constructor(container, context) {
    this.container = container;
    const filePath = context?.path || '';
    const name = filePath.split('/').pop() || 'kanban';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg-primary,#1a1a1a);';
    wrapper.innerHTML = `
      <div style="text-align:center;max-width:360px;padding:24px;">
        <div style="font-size:56px;margin-bottom:12px;">📋</div>
        <div style="font-size:14px;font-weight:600;color:var(--text-primary,#e0e0e0);margin-bottom:4px;word-break:break-word;">${esc(name)}</div>
        <div style="font-size:11px;color:var(--text-secondary,#888);margin-bottom:20px;">Kanban Board</div>
        <button id="kb-open-tab" style="padding:8px 20px;background:var(--accent-color,#1d9bf0);color:var(--accent-contrast-text,#fff);border:none;border-radius:5px;font-size:13px;font-weight:500;cursor:pointer;transition:background 0.15s;">
          Edit in Tab
        </button>
      </div>
    `;
    container.appendChild(wrapper);
    wrapper.querySelector('#kb-open-tab')?.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('pane:open-tab', { bubbles: true, detail: { path: filePath } }));
    });
  }

  getContent() { return undefined; }
  isDirty() { return false; }
  focus() {}
  resize() {}
  dispose() { this.container.innerHTML = ''; }
}

class KanbanEditorInstance {
  constructor(container, context) {
    this.container = container;
    this.filePath = context?.path || '';
    this.dirty = false;
    this.dirtyCallback = null;
    this.disposed = false;
    this.boardEl = null;
    this.pendingContent = null;
    this.lastContent = '';
    this.currentMtime = null;
    this.conflictMonitor = null;
    this.themeListener = () => {
      window.__kanbanEditor?.setTheme?.(isDarkThemeActive());
    };
    this.init(context?.content);
  }

  async resolveInitialContent(content) {
    if (content !== undefined) return content;
    if (!this.filePath) return '';
    try {
      const res = await fetch(`/workspace/file?path=${encodeURIComponent(this.filePath)}&max=1000000&mode=edit`, { credentials: 'same-origin' });
      const data = await res.json();
      if (data?.mtime) this.currentMtime = data.mtime;
      return data?.text || '';
    } catch {
      return '';
    }
  }

  async init(initialContentMaybe) {
    const initialContent = await this.resolveInitialContent(initialContentMaybe);
    if (this.disposed) return;
    this.lastContent = initialContent;

    ensureStylesheet(KANBAN_STYLES_URL);
    this.boardEl = document.createElement('div');
    this.boardEl.id = 'kanban-container';
    this.boardEl.style.cssText = 'width:100%;height:100%;overflow:auto;position:relative;';
    this.container.appendChild(this.boardEl);

    try {
      ensurePreactGlobals();
      await ensureScript(KANBAN_SCRIPT_URL);
      if (this.disposed) return;

      const api = window.__kanbanEditor;
      if (!api) throw new Error('__kanbanEditor not found');

      api.mount(this.boardEl, {
        content: initialContent,
        isDark: isDarkThemeActive(),
        path: this.filePath,
        onEdit: (markdown) => {
          this.lastContent = markdown;
          this.dirty = true;
          this.dirtyCallback?.(true);
          this.saveToWorkspace(markdown);
        },
      });

      if (this.pendingContent !== null) {
        api.update(this.pendingContent);
        this.lastContent = this.pendingContent;
        this.pendingContent = null;
      }

      window.addEventListener('piclaw-theme-change', this.themeListener);
      this.initConflictMonitor();
    } catch (error) {
      console.error('[kanban-editor addon] Failed to load kanban editor:', error);
      if (this.boardEl) {
        this.boardEl.innerHTML = '<div style="padding:24px;color:var(--text-secondary);">Failed to load kanban editor.</div>';
      }
    }
  }

  async saveToWorkspace(markdown) {
    if (!this.filePath) return;
    try {
      const res = await fetch('/workspace/file', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: this.filePath, content: markdown }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json().catch(() => ({}));
      this.currentMtime = payload?.mtime || this.currentMtime;
      this.conflictMonitor?.onSaved(this.currentMtime);
      this.dirty = false;
      this.dirtyCallback?.(false);
    } catch (error) {
      console.error('[kanban-editor addon] Save failed:', error);
    }
  }

  initConflictMonitor() {
    this.conflictMonitor?.dispose();
    if (!this.filePath || !this.boardEl) return;
    this.conflictMonitor = createFileConflictMonitor({
      path: this.filePath,
      getCurrentMtime: () => this.currentMtime,
      anchorParent: this.container,
      anchorBefore: this.boardEl,
      onReload: async () => {
        try {
          const res = await fetch(`/workspace/file?path=${encodeURIComponent(this.filePath)}&max=1000000&mode=edit`, { credentials: 'same-origin' });
          const data = await res.json();
          if (this.disposed) return;
          this.currentMtime = data?.mtime || null;
          const content = data?.text || '';
          this.lastContent = content;
          const api = window.__kanbanEditor;
          if (api?.update) api.update(content);
          this.dirty = false;
          this.dirtyCallback?.(false);
          this.conflictMonitor?.onSaved(this.currentMtime);
        } catch (error) {
          console.error('[kanban-editor addon] Reload failed:', error);
        }
      },
      onSaveCopy: async (copyPath) => {
        try {
          await fetch('/workspace/file', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: copyPath, content: this.lastContent }),
          });
        } catch (error) {
          console.error('[kanban-editor addon] Save copy failed:', error);
        }
      },
      onOverwrite: () => this.saveToWorkspace(this.lastContent),
    });
    this.conflictMonitor.start();
  }

  getContent() { return undefined; }
  isDirty() { return this.dirty; }
  setContent(content) {
    if (content === this.lastContent) return;
    const api = window.__kanbanEditor;
    if (api?.update) api.update(content);
    else this.pendingContent = content;
    this.lastContent = content;
    this.dirty = false;
    this.dirtyCallback?.(false);
  }
  focus() { this.boardEl?.focus?.(); }
  resize() {}
  onDirtyChange(cb) { this.dirtyCallback = cb; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.conflictMonitor?.dispose();
    window.removeEventListener('piclaw-theme-change', this.themeListener);
    window.__kanbanEditor?.destroy?.();
    this.pendingContent = null;
    this.container.innerHTML = '';
  }
}

const webApi = globalThis.__piclaw_web;
if (webApi && typeof webApi.registerPane === 'function') {
  webApi.registerPane({
    id: 'kanban-editor',
    label: 'Kanban Board',
    icon: 'kanban',
    capabilities: ['edit', 'preview'],
    placement: 'tabs',
    canHandle(context) {
      const path = context?.path || '';
      if (!KANBAN_EXTENSION.test(path)) return false;
      return 60;
    },
    mount(container, context) {
      if (context?.mode === 'view') return new KanbanPreviewCard(container, context);
      return new KanbanEditorInstance(container, context);
    },
  });
}
