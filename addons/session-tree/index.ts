/*
 * session-tree/index.ts — Interactive renderer for Piclaw's /tree snapshot.
 *
 * Piclaw core owns command parsing, snapshot extraction, and navigation. This
 * add-on owns the complete interactive renderer and never fetches tree data.
 */

interface SessionTreeSourceNode extends Record<string, unknown> {
  id?: unknown;
  parentId?: unknown;
  active?: unknown;
}

interface SessionTreeWidgetNode extends Record<string, unknown> {
  id: string;
  parentId: string | null;
  type: string;
  active: boolean;
  depth: number;
  childIds: string[];
}

export interface SessionTreeWidgetModel {
  version: 1;
  leafId: string | null;
  total: number;
  rootIds: string[];
  nodes: SessionTreeWidgetNode[];
}

const STRING_FIELDS = [
  "timestamp",
  "label",
  "preview",
  "role",
  "toolName",
  "toolInput",
  "toolInputFull",
  "detail",
  "previewText",
  "rawDetail",
] as const;
const NUMBER_FIELDS = ["contentLength", "rawContentLength", "thinkingLength"] as const;
const BOOLEAN_FIELDS = ["hasThinking"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNode(source: SessionTreeSourceNode): SessionTreeWidgetNode | null {
  const id = cleanId(source.id);
  if (!id) return null;
  const node: SessionTreeWidgetNode = {
    id,
    parentId: cleanId(source.parentId) || null,
    type: cleanId(source.type) || "entry",
    active: source.active === true,
    depth: 0,
    childIds: [],
  };
  for (const field of STRING_FIELDS) {
    if (typeof source[field] === "string") node[field] = source[field];
  }
  for (const field of NUMBER_FIELDS) {
    if (typeof source[field] === "number" && Number.isFinite(source[field])) node[field] = source[field];
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof source[field] === "boolean") node[field] = source[field];
  }
  return node;
}

/** Convert the command's flat snapshot into a cycle-safe hierarchy model. */
export function buildSessionTreeModel(snapshot: unknown): SessionTreeWidgetModel {
  const source = asRecord(snapshot) ?? {};
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const nodes: SessionTreeWidgetNode[] = [];
  const byId = new Map<string, SessionTreeWidgetNode>();

  for (const candidate of rawNodes) {
    const record = asRecord(candidate) as SessionTreeSourceNode | null;
    if (!record) continue;
    const node = normalizeNode(record);
    if (!node || byId.has(node.id)) continue;
    byId.set(node.id, node);
    nodes.push(node);
  }

  const requestedLeafId = cleanId(source.leafId);
  const leafId = byId.has(requestedLeafId)
    ? requestedLeafId
    : nodes.find((node) => node.active)?.id ?? null;
  const rawParentById = new Map<string, string | null>();
  for (const node of nodes) {
    const parentId = node.parentId && byId.has(node.parentId) && node.parentId !== node.id
      ? node.parentId
      : null;
    rawParentById.set(node.id, parentId);
  }

  const parentById = new Map<string, string | null>();
  for (const node of nodes) {
    const initialParentId = rawParentById.get(node.id) ?? null;
    let cursor = initialParentId;
    const seen = new Set([node.id]);
    let cyclic = false;
    while (cursor) {
      if (seen.has(cursor)) {
        cyclic = true;
        break;
      }
      seen.add(cursor);
      cursor = rawParentById.get(cursor) ?? null;
    }
    parentById.set(node.id, cyclic ? null : initialParentId);
  }

  for (const node of nodes) {
    node.parentId = parentById.get(node.id) ?? null;
    node.active = node.id === leafId;
    node.childIds = [];
  }
  const rootIds: string[] = [];
  for (const node of nodes) {
    if (node.parentId) byId.get(node.parentId)?.childIds.push(node.id);
    else rootIds.push(node.id);
  }

  const stack = rootIds.slice().reverse().map((id) => ({ id, depth: 0 }));
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    const node = byId.get(current.id);
    if (!node) continue;
    node.depth = current.depth;
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({ id: node.childIds[index], depth: current.depth + 1 });
    }
  }

  return { version: 1, leafId, total: nodes.length, rootIds, nodes };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Build the self-contained HTML fragment consumed by Piclaw's generic widget host. */
export function buildTreeWidgetHtml(snapshot: unknown, chatJid: string): string {
  const model = buildSessionTreeModel(snapshot);
  return `<style>
:root{color-scheme:dark light;--st-bg:#11141b;--st-panel:#181d27;--st-panel-2:#202735;--st-text:#eef2f8;--st-muted:#9aa7b8;--st-line:#303949;--st-accent:#62a8ff;--st-active:#4fd1a1;--st-danger:#ff7b86;--st-shadow:rgba(0,0,0,.22)}
*{box-sizing:border-box}
body{margin:0;padding:0!important;min-height:100vh;background:var(--st-bg)!important;color:var(--st-text)!important;font:13px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important}
button,input{font:inherit}
.st-shell{display:grid;grid-template-rows:auto minmax(0,1fr);height:100vh;min-height:360px;background:var(--st-bg);overflow:hidden}
.st-toolbar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--st-line);background:var(--st-panel);box-shadow:0 6px 18px var(--st-shadow);z-index:2}
.st-toolbar-group{display:flex;align-items:center;gap:6px}.st-toolbar-group.grow{flex:1;min-width:120px}.st-spacer{flex:1}
.st-btn{min-height:32px;padding:5px 10px;border:1px solid var(--st-line);border-radius:7px;background:var(--st-panel-2);color:var(--st-text);cursor:pointer}.st-btn:hover:not(:disabled){border-color:var(--st-accent);background:#263246}.st-btn:focus-visible,.st-search:focus-visible,.st-row:focus-visible{outline:2px solid var(--st-accent);outline-offset:1px}.st-btn:disabled{opacity:.45;cursor:not-allowed}.st-btn.primary{border-color:color-mix(in srgb,var(--st-accent) 70%,var(--st-line));color:#d9eaff}
.st-search{width:100%;min-height:32px;padding:6px 10px;border:1px solid var(--st-line);border-radius:7px;background:var(--st-bg);color:var(--st-text)}.st-search::placeholder{color:var(--st-muted)}
.st-count,.st-context{color:var(--st-muted);font-size:11px;white-space:nowrap}.st-context{max-width:220px;overflow:hidden;text-overflow:ellipsis}
.st-main{display:grid;grid-template-columns:minmax(0,1fr) minmax(250px,34%);min-height:0}
.st-list{min-height:0;overflow:auto;padding:6px 0 24px;border-right:1px solid var(--st-line)}
.st-row{display:grid;grid-template-columns:auto auto auto minmax(0,1fr) auto;align-items:center;width:100%;min-height:32px;padding:3px 10px 3px 4px;border:0;border-left:3px solid transparent;background:transparent;color:var(--st-text);text-align:left;cursor:pointer}
.st-row:hover{background:rgba(255,255,255,.045)}.st-row.selected{background:rgba(98,168,255,.12);border-left-color:var(--st-accent)}.st-row.active{box-shadow:inset 0 0 0 1px rgba(79,209,161,.28)}
.st-indent{width:calc(var(--depth) * 17px)}.st-toggle{display:inline-grid;place-items:center;width:24px;height:24px;border:0;border-radius:5px;background:transparent;color:var(--st-muted);cursor:pointer}.st-toggle:hover{background:var(--st-panel-2);color:var(--st-text)}.st-toggle.empty{cursor:default}
.st-dot{width:7px;height:7px;margin:0 8px 0 2px;border-radius:50%;background:#687588}.st-row.active .st-dot{background:var(--st-active);box-shadow:0 0 0 3px rgba(79,209,161,.16)}
.st-kind{margin-right:8px;padding:2px 6px;border-radius:5px;background:var(--st-panel-2);color:#c6d3e5;font:600 10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}.st-row[data-role="user"] .st-kind{color:#a9d0ff}.st-row[data-role="assistant"] .st-kind{color:#99e3c8}.st-row[data-role="toolResult"] .st-kind{color:#f3c989}
.st-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.st-label{margin-left:8px;padding:2px 7px;border:1px solid rgba(98,168,255,.35);border-radius:999px;color:#bcd9ff;font-size:10px;white-space:nowrap}
.st-empty{display:grid;place-items:center;min-height:160px;padding:24px;color:var(--st-muted);text-align:center}
.st-detail{min-height:0;overflow:auto;padding:16px;background:var(--st-panel);display:flex;flex-direction:column;gap:14px}.st-detail-empty{margin:auto;color:var(--st-muted)}
.st-section{display:grid;gap:5px}.st-heading{color:var(--st-muted);font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}.st-value{overflow-wrap:anywhere}.st-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}.st-pre{max-height:32vh;margin:0;padding:10px;border:1px solid var(--st-line);border-radius:7px;background:var(--st-bg);color:var(--st-text);white-space:pre-wrap;overflow:auto;overflow-wrap:anywhere}.st-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:auto;padding-top:6px}.st-status{min-height:18px;color:var(--st-muted);font-size:11px}.st-status.error{color:var(--st-danger)}
@media(max-width:720px){.st-shell{min-height:520px}.st-toolbar{flex-wrap:wrap}.st-toolbar-group.grow{order:3;flex-basis:100%}.st-context{display:none}.st-main{grid-template-columns:1fr;grid-template-rows:minmax(220px,1fr) minmax(190px,.75fr)}.st-list{border-right:0;border-bottom:1px solid var(--st-line)}.st-actions{position:sticky;bottom:0;background:var(--st-panel);padding:8px 0 0}}
@media(prefers-color-scheme:light){:root{--st-bg:#f7f9fc;--st-panel:#fff;--st-panel-2:#edf2f8;--st-text:#172033;--st-muted:#627087;--st-line:#d3dbe8;--st-accent:#1769c2;--st-active:#087d5d;--st-danger:#b42334;--st-shadow:rgba(40,55,78,.12)}.st-btn.primary{color:#164f89}.st-row:hover{background:rgba(23,105,194,.05)}.st-row.selected{background:rgba(23,105,194,.1)}.st-kind{color:#33445e}.st-label{color:#175b9e}}
</style>
<div class="st-shell" aria-label="Session tree">
  <header class="st-toolbar">
    <div class="st-toolbar-group"><button class="st-btn" id="st-reopen" type="button" title="Run /tree again to capture a fresh snapshot">Reopen /tree</button><button class="st-btn" id="st-expand" type="button">Expand all</button><button class="st-btn" id="st-collapse" type="button">Collapse all</button></div>
    <div class="st-toolbar-group grow"><input class="st-search" id="st-search" type="search" autocomplete="off" placeholder="Filter ID, label, type, or content…" aria-label="Filter session tree"></div>
    <span class="st-count" id="st-count"></span><span class="st-context" id="st-context"></span>
  </header>
  <main class="st-main"><div class="st-list" id="st-list" role="tree" aria-label="Session tree entries"></div><aside class="st-detail" id="st-detail" aria-live="polite"></aside></main>
</div>
<script>
const SESSION_TREE_MODEL = ${safeJson(model)};
const CHAT_JID = ${safeJson(chatJid)};
const nodesById = new Map(SESSION_TREE_MODEL.nodes.map(node => [node.id, node]));
const collapsed = new Set();
let selectedId = SESSION_TREE_MODEL.leafId || SESSION_TREE_MODEL.rootIds[0] || null;
let filterText = '';
const listEl = document.getElementById('st-list');
const detailEl = document.getElementById('st-detail');
const countEl = document.getElementById('st-count');
const contextEl = document.getElementById('st-context');

function nodeText(node) {
  return [node.id,node.type,node.role,node.toolName,node.label,node.previewText,node.preview,node.detail,node.toolInput,node.toolInputFull,node.rawDetail].filter(value => typeof value === 'string').join(' ').toLowerCase();
}
function rowSummary(node) {
  const value = node.previewText || node.detail || node.toolInput || node.preview || node.type || 'entry';
  return String(value).replace(/^[a-zA-Z]+:\\s*\"?/, '').replace(/\"?\\s*$/, '').split('\\n')[0] || node.type || 'entry';
}
function rowKind(node) { return String(node.toolName || node.role || node.type || 'entry'); }
function matchingIds() {
  const query = filterText.trim().toLowerCase();
  if (!query) return null;
  const included = new Set();
  for (const node of SESSION_TREE_MODEL.nodes) {
    if (!nodeText(node).includes(query)) continue;
    included.add(node.id);
    let parentId = node.parentId;
    while (parentId && !included.has(parentId)) {
      included.add(parentId);
      parentId = nodesById.get(parentId)?.parentId || null;
    }
  }
  return included;
}
function visibleNodes() {
  const included = matchingIds();
  const visible = [];
  const stack = SESSION_TREE_MODEL.rootIds.slice().reverse();
  while (stack.length) {
    const id = stack.pop();
    const node = nodesById.get(id);
    if (!node) continue;
    if (!included || included.has(id)) visible.push(node);
    if (!included && collapsed.has(id)) continue;
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) stack.push(node.childIds[index]);
  }
  return visible;
}
function appendText(parent, className, text) {
  const element = document.createElement('div');
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}
function appendSection(label, value, preformatted) {
  if (value === undefined || value === null || value === '') return;
  const section = document.createElement('section');
  section.className = 'st-section';
  appendText(section, 'st-heading', label);
  const content = appendText(section, preformatted ? 'st-pre st-mono' : 'st-value', String(value));
  if (preformatted) content.setAttribute('role', 'region');
  detailEl.appendChild(section);
}
function renderDetail() {
  detailEl.replaceChildren();
  const node = selectedId ? nodesById.get(selectedId) : null;
  if (!node) { appendText(detailEl, 'st-detail-empty', 'Select an entry to inspect.'); return; }
  appendSection('Entry', node.id, false);
  appendSection('Type', [node.role || node.type, node.toolName].filter(Boolean).join(' → '), false);
  appendSection(node.toolName === 'bash' ? 'Command' : 'Input', node.toolInputFull || node.toolInput, true);
  appendSection(node.role === 'toolResult' ? 'Output' : 'Content', node.detail, true);
  appendSection('Raw prompt', node.rawDetail, true);
  appendSection('Label', node.label, false);
  if (node.timestamp) appendSection('Time', new Date(node.timestamp).toLocaleString(), false);
  const status = document.createElement('div'); status.className = 'st-status'; status.id = 'st-status'; detailEl.appendChild(status);
  const actions = document.createElement('div'); actions.className = 'st-actions';
  const navigate = document.createElement('button'); navigate.className = 'st-btn primary'; navigate.type = 'button'; navigate.textContent = 'Navigate here'; navigate.addEventListener('click', () => submitTreeCommand('/tree ' + selectedId));
  const summarize = document.createElement('button'); summarize.className = 'st-btn'; summarize.type = 'button'; summarize.textContent = 'Navigate + summarize'; summarize.addEventListener('click', () => submitTreeCommand('/tree ' + selectedId + ' --summarize'));
  actions.append(navigate, summarize); detailEl.appendChild(actions);
}
function toggleNode(id) {
  const node = nodesById.get(id); if (!node || !node.childIds.length) return;
  if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
  render();
}
function render() {
  const visible = visibleNodes();
  listEl.replaceChildren();
  if (!visible.length) appendText(listEl, 'st-empty', filterText ? 'No entries match this filter.' : 'The snapshot is empty.');
  for (const node of visible) {
    const row = document.createElement('div');
    row.className = 'st-row' + (node.id === selectedId ? ' selected' : '') + (node.active ? ' active' : '');
    row.dataset.id = node.id; row.dataset.role = String(node.role || node.type || 'entry');
    row.setAttribute('role', 'treeitem'); row.setAttribute('tabindex', '0'); row.setAttribute('aria-level', String(node.depth + 1)); row.setAttribute('aria-selected', String(node.id === selectedId));
    if (node.childIds.length) row.setAttribute('aria-expanded', String(!collapsed.has(node.id)));
    const indent = document.createElement('span'); indent.className = 'st-indent'; indent.style.setProperty('--depth', String(node.depth));
    const toggle = document.createElement('button'); toggle.className = 'st-toggle' + (node.childIds.length ? '' : ' empty'); toggle.type = 'button'; toggle.tabIndex = -1; toggle.setAttribute('aria-label', node.childIds.length ? (collapsed.has(node.id) ? 'Expand branch' : 'Collapse branch') : 'Leaf entry'); toggle.textContent = node.childIds.length ? (collapsed.has(node.id) ? '›' : '⌄') : '·';
    toggle.addEventListener('click', event => { event.stopPropagation(); toggleNode(node.id); });
    const dot = document.createElement('span'); dot.className = 'st-dot'; dot.setAttribute('aria-hidden', 'true');
    const kind = document.createElement('span'); kind.className = 'st-kind'; kind.textContent = rowKind(node);
    const summary = document.createElement('span'); summary.className = 'st-summary'; summary.textContent = rowSummary(node); summary.title = rowSummary(node);
    row.append(indent, toggle, dot, kind, summary);
    if (node.label) { const label = document.createElement('span'); label.className = 'st-label'; label.textContent = String(node.label); row.appendChild(label); }
    row.addEventListener('click', () => { selectedId = node.id; render(); });
    row.addEventListener('dblclick', () => submitTreeCommand('/tree ' + node.id));
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); selectedId = node.id; render(); }
      if (event.key === 'ArrowRight' && collapsed.has(node.id)) { event.preventDefault(); collapsed.delete(node.id); render(); }
      if (event.key === 'ArrowLeft' && node.childIds.length && !collapsed.has(node.id)) { event.preventDefault(); collapsed.add(node.id); render(); }
    });
    listEl.appendChild(row);
  }
  countEl.textContent = visible.length + ' / ' + SESSION_TREE_MODEL.total;
  contextEl.textContent = CHAT_JID ? 'Snapshot · ' + CHAT_JID : 'Invocation snapshot';
  renderDetail();
}
function submitTreeCommand(command) {
  const status = document.getElementById('st-status');
  if (!window.piclawWidget || typeof window.piclawWidget.submit !== 'function') {
    if (status) { status.className = 'st-status error'; status.textContent = 'Widget bridge unavailable.'; }
    return;
  }
  window.piclawWidget.submit({ text: command });
  if (status) { status.className = 'st-status'; status.textContent = 'Sent ' + command; }
}
document.getElementById('st-search').addEventListener('input', event => { filterText = event.currentTarget.value || ''; render(); });
document.getElementById('st-search').addEventListener('keydown', event => { if (event.key === 'Escape') { event.currentTarget.value = ''; filterText = ''; render(); } });
document.getElementById('st-expand').addEventListener('click', () => { collapsed.clear(); render(); });
document.getElementById('st-collapse').addEventListener('click', () => { for (const node of SESSION_TREE_MODEL.nodes) if (node.childIds.length) collapsed.add(node.id); render(); });
document.getElementById('st-reopen').addEventListener('click', () => submitTreeCommand('/tree'));
render();
requestAnimationFrame(() => document.querySelector('.st-row.active, .st-row.selected')?.scrollIntoView({ block: 'center' }));
</script>`;
}

export default function sessionTreeAddon(_pi: unknown): void {
  const register = (globalThis as Record<string, unknown>).__piclaw_registerWidgetKind;
  if (typeof register === "function") {
    (register as (kind: string, renderer: (artifact: Record<string, unknown>) => string) => void)(
      "session_tree",
      (artifact) => buildTreeWidgetHtml(artifact.tree, cleanId(artifact.chatJid)),
    );
    console.log("[session-tree] Widget kind 'session_tree' registered via __piclaw_registerWidgetKind.");
  } else {
    console.warn("[session-tree] __piclaw_registerWidgetKind not available — tree widget will use text fallback.");
  }
}
