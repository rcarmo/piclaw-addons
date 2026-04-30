// @ts-nocheck

function generateCopyPath(originalPath) {
  const ext = originalPath.includes('.') ? originalPath.slice(originalPath.lastIndexOf('.')) : '';
  const base = originalPath.includes('.') ? originalPath.slice(0, originalPath.lastIndexOf('.')) : originalPath;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${base}.${stamp}${ext}`;
}

async function getWorkspaceFileStat(path) {
  const response = await fetch(`/workspace/stat?path=${encodeURIComponent(path)}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function createFileConflictMonitor(opts) {
  const {
    path,
    getCurrentMtime,
    anchorParent,
    anchorBefore,
    onReload,
    onSaveCopy,
    onOverwrite,
    pollMs = 3000,
    ownerDocument = document,
  } = opts;

  let timer = null;
  let barEl = null;
  let detected = false;
  let disposed = false;
  let saving = false;

  async function checkMtime() {
    if (disposed || saving || detected) return;
    const knownMtime = getCurrentMtime();
    if (!knownMtime) return;
    try {
      const stat = await getWorkspaceFileStat(path);
      if (disposed || saving || !stat?.mtime) return;
      if (stat.mtime !== knownMtime) {
        detected = true;
        stopPolling();
        showBar();
      }
    } catch (error) {
      console.debug('[kanban-editor] mtime poll skipped:', error);
    }
  }

  function startPolling() {
    stopPolling();
    if (disposed) return;
    timer = setInterval(checkMtime, pollMs);
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function dismissBar() {
    if (barEl) {
      barEl.remove();
      barEl = null;
    }
    detected = false;
    startPolling();
  }

  function showBar() {
    if (barEl || disposed) return;
    const bar = ownerDocument.createElement('div');
    bar.className = 'editor-conflict-bar';
    bar.innerHTML = `
      <span class="editor-conflict-text">File changed on disk</span>
      <div class="editor-conflict-actions">
        <button class="editor-conflict-btn" data-action="reload" title="Discard and reload from disk">Reload</button>
        <button class="editor-conflict-btn" data-action="save-copy" title="Save current content with a new name">Save copy</button>
        <button class="editor-conflict-btn" data-action="overwrite" title="Overwrite the disk version">Overwrite</button>
        <button class="editor-conflict-btn editor-conflict-dismiss" data-action="dismiss" title="Dismiss">×</button>
      </div>
    `;
    bar.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-action]');
      if (!button) return;
      const action = button.getAttribute('data-action');
      if (action === 'reload') {
        dismissBar();
        onReload();
      } else if (action === 'save-copy') {
        onSaveCopy(generateCopyPath(path));
      } else if (action === 'overwrite') {
        dismissBar();
        onOverwrite();
      } else if (action === 'dismiss') {
        dismissBar();
      }
    });
    barEl = bar;
    anchorParent.insertBefore(bar, anchorBefore);
  }

  return {
    start() {
      startPolling();
    },
    stop() {
      stopPolling();
    },
    onSaved() {
      detected = false;
      saving = false;
      startPolling();
    },
    dispose() {
      disposed = true;
      stopPolling();
      if (barEl) {
        barEl.remove();
        barEl = null;
      }
    },
  };
}
