/**
 * session-tree/index.ts — Session tree timeline widget addon.
 *
 * Registers a tree widget HTML provider via __piclaw_registerTreeWidgetHtml.
 * When loaded, the /tree command emits an HTML dashboard widget instead of
 * plain text, giving an interactive expandable session tree in the web UI.
 */

function buildTreeWidgetHtml(leafId: string, chatJid: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:13px/1.4 system-ui,sans-serif;background:var(--bg,#1e1e1e);color:var(--fg,#ccc);
       overflow:hidden;height:100vh;display:flex;flex-direction:column}
  #toolbar{flex:0 0 auto;padding:6px 8px;background:var(--bg2,#252526);border-bottom:1px solid #333;
           display:flex;gap:6px;align-items:center}
  #search{flex:1;background:#333;border:1px solid #444;color:#ccc;padding:3px 6px;border-radius:3px;font-size:12px}
  #search::placeholder{color:#666}
  button{padding:3px 8px;background:#333;border:1px solid #444;color:#ccc;border-radius:3px;
         cursor:pointer;font-size:12px;white-space:nowrap}
  button:hover{background:#444} button:disabled{opacity:.5;cursor:default}
  #tree{flex:1;overflow-y:auto;padding:4px 0}
  .row{display:flex;align-items:center;padding:3px 8px;cursor:pointer;gap:4px;
       border-left:2px solid transparent}
  .row:hover{background:rgba(255,255,255,.05)}
  .row.active{border-left-color:#569cd6;background:rgba(86,156,214,.1)}
  .row.leaf{border-left-color:#4ec94e;background:rgba(78,201,78,.07)}
  .indent{display:inline-block;flex-shrink:0}
  .toggle{width:14px;text-align:center;color:#666;flex-shrink:0;font-size:10px;user-select:none}
  .toggle.leaf-marker{color:#4ec94e}
  .id{font-family:monospace;font-size:11px;color:#888;flex-shrink:0;min-width:70px}
  .label{font-size:11px;color:#ce9178;margin-right:4px}
  .summary{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px}
  .meta{font-size:10px;color:#666;flex-shrink:0}
  #status{padding:4px 8px;font-size:11px;color:#888;text-align:center}
  .match-highlight{background:rgba(255,220,0,.25);border-radius:2px}
</style>
</head>
<body>
<div id="toolbar">
  <button id="btn-refresh">Refresh</button>
  <input id="search" type="text" placeholder="Filter…" autocomplete="off">
  <span id="status-inline"></span>
</div>
<div id="tree"><div id="status">Loading…</div></div>
<script>
const LEAF_ID = ${JSON.stringify(leafId)};
const CHAT_JID = ${JSON.stringify(chatJid)};
let allRows = [], collapsed = new Set(), filterText = '';

async function load() {
  document.getElementById('status-inline').textContent = '';
  document.getElementById('tree').innerHTML = '<div id="status">Loading…</div>';
  try {
    const qs = new URLSearchParams();
    if (CHAT_JID) qs.set('chat_jid', CHAT_JID);
    const r = await fetch('/agent/session-tree?' + qs, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
    const data = await r.json();
    allRows = flattenTree(data.nodes || data.roots || []);
    render();
  } catch(e) {
    document.getElementById('tree').innerHTML = '<div id="status" style="color:#f44">Error: ' + e.message + '</div>';
  }
}

function flattenTree(nodes, depth = 0, parentVisible = true) {
  const rows = [];
  for (const n of nodes) {
    rows.push({ ...n, depth, hasChildren: (n.children||[]).length > 0 });
    if ((n.children||[]).length > 0 && !collapsed.has(n.id)) {
      rows.push(...flattenTree(n.children, depth + 1));
    }
  }
  return rows;
}

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function hl(s, q) {
  if (!q) return escHtml(s);
  const i = s.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return escHtml(s);
  return escHtml(s.slice(0,i)) + '<mark class="match-highlight">' + escHtml(s.slice(i,i+q.length)) + '</mark>' + escHtml(s.slice(i+q.length));
}

function render() {
  const q = filterText.toLowerCase();
  const visible = q ? allRows.filter(r => (r.id||'').toLowerCase().includes(q) || (r.summary||'').toLowerCase().includes(q) || (r.label||'').toLowerCase().includes(q)) : allRows;
  document.getElementById('status-inline').textContent = q ? visible.length + ' match' + (visible.length!==1?'es':'') : '';
  if (!visible.length) {
    document.getElementById('tree').innerHTML = '<div id="status">' + (q ? 'No matches.' : 'Empty.') + '</div>';
    return;
  }
  const html = visible.map(n => {
    const isLeaf = n.id === LEAF_ID;
    const isActive = isLeaf;
    const indent = n.depth * 16;
    const toggle = n.hasChildren ? (collapsed.has(n.id) ? '▶' : '▼') : (isLeaf ? '●' : '·');
    const toggleClass = isLeaf ? 'toggle leaf-marker' : 'toggle';
    const rowClass = 'row' + (isActive ? ' active' : '') + (isLeaf ? ' leaf' : '');
    const shortId = (n.id||'').slice(-7);
    const summary = hl(n.summary || n.type || '', q);
    const labelHtml = n.label ? '<span class="label">[' + escHtml(n.label) + ']</span>' : '';
    const meta = n.timestamp ? '<span class="meta">' + escHtml(new Date(n.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})) + '</span>' : '';
    return '<div class="' + rowClass + '" data-id="' + escHtml(n.id||'') + '" data-has-children="' + (n.hasChildren?'1':'0') + '">'
      + '<span class="indent" style="width:' + indent + 'px"></span>'
      + '<span class="' + toggleClass + '">' + toggle + '</span>'
      + '<span class="id">' + escHtml(shortId) + '</span>'
      + labelHtml
      + '<span class="summary">' + summary + '</span>'
      + meta
      + '</div>';
  }).join('');
  document.getElementById('tree').innerHTML = html;
}

document.getElementById('tree').addEventListener('click', e => {
  const row = e.target.closest('.row');
  if (!row) return;
  const id = row.dataset.id;
  if (!id) return;
  const toggle = e.target.closest('.toggle');
  if (toggle && row.dataset.hasChildren === '1') {
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    allRows = flattenTree(/* reflatten from original */[]);
    load(); return;
  }
  window.piclawWidget?.submit({ text: '/tree ' + id });
});

document.getElementById('btn-refresh').addEventListener('click', load);
document.getElementById('search').addEventListener('input', e => {
  filterText = e.target.value;
  render();
});
document.getElementById('search').addEventListener('keydown', e => {
  if (e.key === 'Escape') { filterText = ''; e.target.value = ''; render(); }
});

load();
</script>
</body>
</html>`;
}

export default function sessionTreeAddon(_pi: any): void {
  const register = (globalThis as any).__piclaw_registerTreeWidgetHtml;
  if (typeof register === "function") {
    register(buildTreeWidgetHtml);
    console.log("[session-tree] Tree widget HTML provider registered.");
  } else {
    console.warn("[session-tree] __piclaw_registerTreeWidgetHtml not available — tree widget will use text fallback.");
  }
}
