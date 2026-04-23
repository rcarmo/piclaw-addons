/**
 * kanban-board-widget.ts – /board slash command that renders an interactive
 * kanban board widget with drag & drop support.
 *
 * Drop into .pi/extensions/ and /reload.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readdirSync, readFileSync, renameSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

/* ── Lane definitions ─────────────────────────────────────────────── */

interface Lane {
  dir: string;
  key: string;
  label: string;
}

const LANES: Lane[] = [
  { dir: "00-inbox", key: "inbox", label: "Inbox" },
  { dir: "10-next", key: "next", label: "Next" },
  { dir: "20-doing", key: "doing", label: "Doing" },
  { dir: "30-blocked", key: "blocked", label: "Blocked" },
  { dir: "40-review", key: "review", label: "Review" },
  { dir: "50-done", key: "done", label: "Done" },
];


/* ── Ticket parsing ───────────────────────────────────────────────── */

interface Ticket {
  id: string;
  title: string;
  status: string;
  priority: string;
  estimate: string;
  risk: string;
  tags: string[];
  created: string;
  updated: string;
  targetRelease: string;
  completed: string;
  quality: number;
  summary: string;
  acceptanceCriteriaRaw: string;
  body: string;
  laneKey: string;
  laneLabel: string;
  filename: string;
  parseError: boolean;
}

function parseFrontMatter(content: string): Record<string, string> {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    fm[key] = val;
  }
  return fm;
}

function parseTags(raw: string): string[] {
  const m = raw.match(/\[(.*)\]/);
  if (!m) return raw ? [raw] : [];
  return m[1].split(",").map((t) => t.trim()).filter(Boolean);
}

function extractSection(content: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}[\\s\\S]*?$`, "mi");
  const m = content.match(re);
  if (!m) return "";
  const start = (m.index ?? 0) + m[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.match(/^##\s/m);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return section.trim();
}

function extractQuality(content: string, fm: Record<string, string>): number {
  if (fm.quality) {
    const n = parseInt(fm.quality, 10);
    if (!Number.isNaN(n)) return n;
  }
  const m = content.match(/[Qq]uality[:\s]*(?:★+\s*)?(\d+)\s*\/?\s*10?/);
  return m ? parseInt(m[1], 10) : 0;
}

function parseTicket(filepath: string, laneKey: string, laneLabel: string): Ticket {
  const filename = basename(filepath, ".md");
  try {
    const content = readFileSync(filepath, "utf-8");
    const fm = parseFrontMatter(content);
    return {
      id: fm.id || filename,
      title: fm.title || filename,
      status: fm.status || laneKey,
      priority: fm.priority || "medium",
      estimate: fm.estimate || "",
      risk: fm.risk || "",
      tags: parseTags(fm.tags || ""),
      created: fm.created || "",
      updated: fm.updated || "",
      targetRelease: fm.target_release || "",
      completed: fm.completed || "",
      quality: extractQuality(content, fm),
      summary: extractSection(content, "Summary").slice(0, 500),
      acceptanceCriteriaRaw: extractSection(content, "Acceptance Criteria"),
      body: (content.match(/^---[\s\S]*?---\r?\n([\s\S]*)/) || ["",""])[1].trim(),
      laneKey,
      laneLabel,
      filename,
      parseError: false,
    };
  } catch {
    return {
      id: filename, title: filename, status: laneKey, priority: "medium",
      estimate: "", risk: "", tags: [], created: "", targetRelease: "", completed: "",
      quality: 0, summary: "", acceptanceCriteriaRaw: "", body: "", updated: "",
      laneKey, laneLabel, filename, parseError: true,
    };
  }
}

function scanBoard(workitemsDir: string): Map<string, Ticket[]> {
  const board = new Map<string, Ticket[]>();
  for (const lane of LANES) {
    const dir = join(workitemsDir, lane.dir);
    const tickets: Ticket[] = [];
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      for (const f of files) {
        tickets.push(parseTicket(join(dir, f), lane.key, lane.label));
      }
    } catch {
      // dir doesn't exist — empty lane
    }
    board.set(lane.key, tickets);
  }
  return board;
}


/* ── Theme palettes (single source of truth) ──────────────────────── */

const THEME_VARS = [
  "bg-body","bg-surface","bg-hover","bg-card","bg-drag-over",
  "border","border-accent",
  "text-primary","text-secondary","text-muted","text-dim",
  "accent","accent-bright","accent-pill","accent-pill-text",
  "badge-critical-bg","badge-critical-fg","badge-high-bg","badge-high-fg",
  "badge-medium-bg","badge-medium-fg","badge-low-bg","badge-low-fg",
  "badge-estimate-bg","badge-estimate-fg",
  "badge-tag-bg","badge-tag-fg","badge-tag-border",
  "badge-error-bg","badge-error-fg",
  "stars","toast-bg","toast-border","code-bg","pre-bg","link",
  "blockquote-border","blockquote-text",
  "table-border","table-header-bg","table-header-fg","shadow",
] as const;

type ThemePalette = Record<(typeof THEME_VARS)[number], string>;

const DARK: ThemePalette = {
  "bg-body":"#09090b", "bg-surface":"#18181b", "bg-hover":"#3f3f46", "bg-card":"#09090b",
  "bg-drag-over":"#14282b", "border":"#27272a", "border-accent":"#14b8a6",
  "text-primary":"#fafafa", "text-secondary":"#d4d4d8", "text-muted":"#a1a1aa", "text-dim":"#71717a",
  "accent":"#14b8a6", "accent-bright":"#2dd4bf", "accent-pill":"#0f766e", "accent-pill-text":"#f0fdfa",
  "badge-critical-bg":"#991b1b", "badge-critical-fg":"#fca5a5",
  "badge-high-bg":"#92400e", "badge-high-fg":"#fbbf24",
  "badge-medium-bg":"#134e4a", "badge-medium-fg":"#99f6e4",
  "badge-low-bg":"#18181b", "badge-low-fg":"#71717a",
  "badge-estimate-bg":"#134e4a", "badge-estimate-fg":"#a7f3d0",
  "badge-tag-bg":"#18181b", "badge-tag-fg":"#71717a", "badge-tag-border":"#27272a",
  "badge-error-bg":"#991b1b", "badge-error-fg":"#fca5a5",
  "stars":"#f59e0b", "toast-bg":"#27272a", "toast-border":"#3f3f46",
  "code-bg":"#27272a", "pre-bg":"#18181b", "link":"#2dd4bf",
  "blockquote-border":"#14b8a6", "blockquote-text":"#a1a1aa",
  "table-border":"#27272a", "table-header-bg":"#18181b", "table-header-fg":"#a1a1aa",
  "shadow":"rgba(0,0,0,0.3)",
};

const LIGHT: ThemePalette = {
  "bg-body":"#e8e8ec", "bg-surface":"#e4e4e7", "bg-hover":"#d4d4d8", "bg-card":"#ffffff",
  "bg-drag-over":"#ccfbf1", "border":"#a1a1aa", "border-accent":"#0d9488",
  "text-primary":"#18181b", "text-secondary":"#27272a", "text-muted":"#3f3f46", "text-dim":"#52525b",
  "accent":"#0d9488", "accent-bright":"#14b8a6", "accent-pill":"#0d9488", "accent-pill-text":"#ffffff",
  "badge-critical-bg":"#fee2e2", "badge-critical-fg":"#991b1b",
  "badge-high-bg":"#fef3c7", "badge-high-fg":"#92400e",
  "badge-medium-bg":"#ccfbf1", "badge-medium-fg":"#134e4a",
  "badge-low-bg":"#e4e4e7", "badge-low-fg":"#52525b",
  "badge-estimate-bg":"#ccfbf1", "badge-estimate-fg":"#134e4a",
  "badge-tag-bg":"#e4e4e7", "badge-tag-fg":"#3f3f46", "badge-tag-border":"#a1a1aa",
  "badge-error-bg":"#fee2e2", "badge-error-fg":"#991b1b",
  "stars":"#d97706", "toast-bg":"#f4f4f5", "toast-border":"#a1a1aa",
  "code-bg":"#d4d4d8", "pre-bg":"#e4e4e7", "link":"#0d9488",
  "blockquote-border":"#0d9488", "blockquote-text":"#71717a",
  "table-border":"#a1a1aa", "table-header-bg":"#e4e4e7", "table-header-fg":"#52525b",
  "shadow":"rgba(0,0,0,0.12)",
};

function paletteToCSS(p: ThemePalette): string {
  return THEME_VARS.map((v) => `  --${v}: ${p[v]};`).join("\n");
}

/* ── HTML Widget ──────────────────────────────────────────────────── */

function buildWidgetHTML(board: Map<string, Ticket[]>): string {
  const allTickets: Ticket[] = [];
  for (const tickets of board.values()) allTickets.push(...tickets);

  // Escape for safe embedding in <script> — prevent </script> injection
  const ticketsJSON = JSON.stringify(allTickets).replace(/<\//g, "<\\/");
  const lanesJSON = JSON.stringify(LANES).replace(/<\//g, "<\\/");

  const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html[data-theme="dark"] {
${paletteToCSS(DARK)}
}
html[data-theme="light"] {
${paletteToCSS(LIGHT)}
}
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg-body); color: var(--text-primary); overflow-x: auto;
}
.toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 100;
}
.toolbar h1 { font-size: 16px; font-weight: 600; flex: 1; }
.toolbar .count { color: var(--text-dim); font-size: 13px; margin-left: 8px; font-weight: 400; }
.btn {
  background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border);
  border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer;
  transition: background 0.15s;
}
.btn:hover { background: var(--bg-surface); }
.board {
  display: flex; gap: 8px; padding: 12px;
  min-height: calc(100vh - 52px); align-items: flex-start;
  overflow-x: auto;
}
.lane {
  flex: 1 0 160px; min-width: 160px; max-width: 280px;
  background: var(--bg-surface); border-radius: 10px;
  border: 2px solid transparent;
  transition: border-color 0.2s, background 0.2s;
  display: flex; flex-direction: column;
}
.lane.drag-over { border-color: var(--border-accent); background: var(--bg-drag-over); }
.lane-header {
  padding: 12px 14px 8px; display: flex; align-items: center; gap: 8px;
  border-bottom: 1px solid var(--border);
}
.lane-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.lane-count {
  background: var(--border); color: var(--text-muted); font-size: 11px; font-weight: 600;
  padding: 2px 7px; border-radius: 10px; min-width: 20px; text-align: center;
}
.lane-body { padding: 8px; flex: 1; min-height: 60px; max-height: calc(100vh - 120px); overflow-y: auto; }
.lane-empty { color: var(--text-dim); font-size: 12px; text-align: center; padding: 20px 8px; font-style: italic; }
.card {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; margin-bottom: 8px; cursor: grab;
  transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s, opacity 0.15s;
  position: relative;
}
.card:hover { border-color: var(--border-accent); transform: translateY(-1px); box-shadow: 0 4px 12px var(--shadow); }
.card.dragging { opacity: 0.4; border-color: var(--border-accent); cursor: grabbing; }
.card.drop-before { border-top: 3px solid var(--border-accent); margin-top: -1px; }
.card.drop-after { border-bottom: 3px solid var(--border-accent); margin-bottom: -1px; }
.card-title { font-size: 13px; font-weight: 500; margin-bottom: 6px; line-height: 1.3; }
.card-meta { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.badge {
  font-size: 10px; padding: 2px 6px; border-radius: 4px;
  font-weight: 500; display: inline-flex; align-items: center; gap: 2px;
}
.badge-priority-critical { background: var(--badge-critical-bg); color: var(--badge-critical-fg); }
.badge-priority-high { background: var(--badge-high-bg); color: var(--badge-high-fg); }
.badge-priority-medium { background: var(--badge-medium-bg); color: var(--badge-medium-fg); }
.badge-priority-low { background: var(--badge-low-bg); color: var(--badge-low-fg); }
.badge-estimate { background: var(--badge-estimate-bg); color: var(--badge-estimate-fg); }
.badge-tag { background: var(--badge-tag-bg); color: var(--badge-tag-fg); border: 1px solid var(--badge-tag-border); }
.badge-error { background: var(--badge-error-bg); color: var(--badge-error-fg); }
.quality-stars { font-size: 10px; color: var(--stars); letter-spacing: 1px; }
.card-actions {
  position: absolute; top: 6px; right: 6px; display: none; gap: 2px;
}
.card:hover .card-actions { display: flex; }
.card-action {
  width: 24px; height: 24px; border-radius: 4px; border: none;
  background: var(--border); color: var(--text-primary); cursor: pointer; font-size: 12px;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s;
}
.card-action:hover { background: var(--bg-hover); }
.drag-handle {
  position: absolute; top: 10px; left: 4px; color: var(--text-dim);
  font-size: 10px; cursor: grab; user-select: none;
  opacity: 0; transition: opacity 0.15s;
}
.card:hover .drag-handle { opacity: 1; }
.detail-view { display: none; padding: 16px; max-width: 700px; margin: 0 auto; }
.detail-view.active { display: block; }
.detail-header { margin-bottom: 16px; }
.detail-title { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
.detail-id { font-size: 12px; color: var(--text-dim); }
.detail-meta {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px; margin-bottom: 16px;
}
.meta-item { background: var(--bg-surface); border-radius: 6px; padding: 8px 10px; }
.meta-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
.meta-value { font-size: 13px; }
.detail-section { margin-bottom: 16px; }
.detail-section h3 {
  font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--text-dim); margin-bottom: 8px; padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.detail-section p, .detail-section li { font-size: 13px; line-height: 1.6; color: var(--text-secondary); }
.detail-section code { background: var(--code-bg); padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.detail-section pre { background: var(--bg-surface); padding: 8px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
.detail-section pre code { background: none; padding: 0; }
.detail-section a { color: var(--link); text-decoration: none; }
.detail-section a:hover { text-decoration: underline; }
.detail-section table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.detail-section th, .detail-section td { border: 1px solid var(--table-border); padding: 6px 8px; text-align: left; }
.detail-section th { background: var(--table-header-bg); color: var(--table-header-fg); font-weight: 600; text-transform: uppercase; font-size: 11px; }
.detail-section td { color: var(--text-secondary); }
.detail-section blockquote { border-left: 3px solid var(--blockquote-border); padding-left: 12px; margin: 8px 0; color: var(--blockquote-text); }
.detail-section h4, .detail-section h5 { color: var(--text-primary); margin: 8px 0 4px; font-size: 13px; }
.detail-section strong { color: var(--text-primary); }
.detail-section ul { list-style: disc; padding-left: 20px; margin: 4px 0; color: var(--text-dim); }
.detail-section ol { padding-left: 20px; margin: 4px 0; }
.detail-section li { padding-left: 4px; margin-bottom: 2px; }
.detail-section li p { display: inline; margin: 0; }
.detail-section li > ul, .detail-section li > ol { margin-top: 2px; }
.lane-strip {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 16px; padding: 10px; background: var(--bg-surface); border-radius: 8px;
}
.lane-pill {
  font-size: 11px; padding: 4px 10px; border-radius: 12px;
  background: var(--border); color: var(--text-muted); cursor: pointer; border: none;
  transition: background 0.15s, color 0.15s;
}
.lane-pill:hover { background: var(--bg-hover); color: var(--text-primary); }
.lane-pill.active { background: var(--accent-pill); color: var(--accent-pill-text); }
.lane-arrow {
  font-size: 14px; background: var(--border); color: var(--text-primary); border: none;
  border-radius: 6px; width: 28px; height: 28px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s;
}
.lane-arrow:hover:not(:disabled) { background: var(--bg-hover); }
.lane-arrow:disabled { opacity: 0.3; cursor: not-allowed; }
.toast {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
  background: var(--toast-bg); color: var(--text-primary); padding: 8px 16px; border-radius: 8px;
  font-size: 12px; z-index: 200; opacity: 0; transition: opacity 0.3s;
  max-width: 90%; text-align: center; border: 1px solid var(--toast-border);
}
.toast.show { opacity: 1; }
`;

  const JS = `
var TICKETS = ${ticketsJSON};
var LANES = ${lanesJSON};
var IS_FULL_PAGE = !!(window.location && window.location.pathname === "/board-page");
var currentTicket = null;

function el(id) { return document.getElementById(id); }
function escapeHtml(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }
function renderMd(s) { if(window.marked) try { return marked.parse(s); } catch(e) {} return escapeHtml(s); }
function priorityClass(p) { return "badge-priority-" + (p || "medium"); }
function priorityIcon(p) { return {critical:"🔴",high:"🟠",medium:"🟡",low:"⚪"}[p] || "🟡"; }
function qualityStars(q) { if(!q)return""; var f=Math.min(q,5); return "★".repeat(f)+"☆".repeat(5-f); }
function laneDir(key) { var l=LANES.find(function(x){return x.key===key}); return l?l.dir:key; }
function currentLaneDir() { return currentTicket?laneDir(currentTicket.laneKey):""; }
function laneIndex(key) { for(var i=0;i<LANES.length;i++) if(LANES[i].key===key)return i; return -1; }

var toastTimer;
function showToast(msg) {
  var t = el("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){t.classList.remove("show");}, 2500);
}
function sendCmd(text) {
  if(window.piclawWidget) {
    piclawWidget.submit({text:text});
  } else if(IS_FULL_PAGE) {
    fetch("/agent/default/message", {
      method:"POST", credentials:"same-origin",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({content:text})
    }).catch(function(){});
  }
  showToast("Sent: "+text);
}

function moveTicket(ticketId, toLane) {
  if(IS_FULL_PAGE) {
    fetch("/api/board/move", {
      method:"POST", credentials:"same-origin",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({id:ticketId,to:toLane})
    }).then(function(r){
      if(!r.ok) throw new Error(r.status+" "+r.statusText);
      return r.json();
    }).then(function(){
      showToast("Moved "+ticketId+" \u2192 "+toLane);
      refreshBoard();
    }).catch(function(e){ showToast("Move failed: "+e.message); });
  } else {
    sendCmd("move "+ticketId+" to "+toLane);
  }
}

function refreshBoard() {
  if(!IS_FULL_PAGE) return;
  fetch("/api/board", {credentials:"same-origin"})
    .then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(data){
      if(data.tickets) TICKETS = data.tickets;
      if(currentTicket) {
        var updated = TICKETS.find(function(t){return t.id===currentTicket.id});
        if(updated) { currentTicket=updated; showDetail(updated); }
        else showBoard();
      } else { renderBoard(); }
    })
    .catch(function(e){ showToast("Refresh failed: "+e.message); });
}

function renderBoard() {
  var container = el("board-view");
  container.innerHTML = "";
  var total = 0;
  var lanesToShow = LANES;

  var priorityOrder = {critical:1, high:2, medium:3, low:4};
  function byPriority(a,b) {
    var p = (priorityOrder[a.priority]||99) - (priorityOrder[b.priority]||99);
    if(p!==0) return p;
    return (b.updated||b.created||"").localeCompare(a.updated||a.created||"");
  }

  lanesToShow.forEach(function(lane) {
    var tickets = TICKETS.filter(function(t){return t.laneKey===lane.key});
    if(lane.key === "done") {
      // Done lane: sort by completed date, newest first. Not reorderable.
      tickets.sort(function(a,b) {
        return (b.completed||b.updated||b.created||"").localeCompare(a.completed||a.updated||a.created||"");
      });
    } else {
      var savedOrder = null;
      try { var so = localStorage.getItem("lane-order-"+lane.key); if(so) savedOrder = JSON.parse(so); } catch(ex) {}
      if(savedOrder) {
        tickets.sort(function(a,b) {
          var ia = savedOrder.indexOf(a.id);
          var ib = savedOrder.indexOf(b.id);
          if(ia===-1 && ib===-1) return byPriority(a,b);
          if(ia===-1) return 1;
          if(ib===-1) return -1;
          return ia - ib;
        });
      } else {
        tickets.sort(byPriority);
      }
    }
    total += tickets.length;

    var col = document.createElement("div");
    col.className = "lane";
    col.dataset.lane = lane.key;

    col.addEventListener("dragover", function(e) {
      e.preventDefault(); e.dataTransfer.dropEffect="move"; col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", function(e) {
      if(!col.contains(e.relatedTarget)) col.classList.remove("drag-over");
    });
    col.addEventListener("drop", function(e) {
      e.preventDefault(); col.classList.remove("drag-over");
      document.querySelectorAll(".card.drop-before,.card.drop-after").forEach(function(c){c.classList.remove("drop-before","drop-after")});
      var tid = e.dataTransfer.getData("text/plain");
      var src = e.dataTransfer.getData("application/x-source-lane");
      if(!tid) return;
      var ticket = TICKETS.find(function(t){return t.id===tid});
      if(!ticket) return;

      if(src === lane.key) {
        // Same-lane reorder (skip for done lane — not reorderable)
        if(lane.key === "done") return;
        var cards = col.querySelectorAll(".card");
        var insertBeforeId = null;
        for(var ci=0; ci<cards.length; ci++) {
          var rect = cards[ci].getBoundingClientRect();
          if(e.clientY < rect.top + rect.height/2) {
            insertBeforeId = cards[ci].dataset.id;
            break;
          }
        }
        // Reorder in TICKETS array
        var laneTickets = TICKETS.filter(function(t){return t.laneKey===lane.key});
        laneTickets = laneTickets.filter(function(t){return t.id!==tid});
        if(insertBeforeId) {
          var idx = laneTickets.findIndex(function(t){return t.id===insertBeforeId});
          if(idx===-1) laneTickets.push(ticket);
          else laneTickets.splice(idx, 0, ticket);
        } else {
          laneTickets.push(ticket);
        }
        // Save custom order
        var order = laneTickets.map(function(t){return t.id});
        try { localStorage.setItem("lane-order-"+lane.key, JSON.stringify(order)); } catch(ex) {}
        renderBoard();
      } else {
        // Cross-lane move
        ticket.laneKey=lane.key; ticket.laneLabel=lane.label;
        // Append to saved order for target lane (preserve existing custom sort)
        try {
          var existingOrder = localStorage.getItem("lane-order-"+lane.key);
          var orderArr = existingOrder ? JSON.parse(existingOrder) : [];
          if(orderArr.indexOf(tid) === -1) orderArr.push(tid);
          localStorage.setItem("lane-order-"+lane.key, JSON.stringify(orderArr));
        } catch(ex) {}
        renderBoard();
        moveTicket(tid, lane.key);
      }
    });

    var header = document.createElement("div");
    header.className = "lane-header";
    header.innerHTML = '<span class="lane-title">'+escapeHtml(lane.label)+'</span><span class="lane-count">'+tickets.length+'</span>';
    col.appendChild(header);

    var body = document.createElement("div");
    body.className = "lane-body";

    if(tickets.length===0) {
      body.innerHTML = '<div class="lane-empty">No items</div>';
    } else {
      tickets.forEach(function(t) {
        var card = document.createElement("div");
        card.className = "card";
        card.draggable = true;
        card.dataset.id = t.id;

        card.addEventListener("dragstart", function(e) {
          e.dataTransfer.setData("text/plain", t.id);
          e.dataTransfer.setData("application/x-source-lane", t.laneKey);
          e.dataTransfer.effectAllowed = "move";
          card.classList.add("dragging");
        });
        card.addEventListener("dragend", function() {
          card.classList.remove("dragging");
          document.querySelectorAll(".lane.drag-over").forEach(function(l){l.classList.remove("drag-over")});
          document.querySelectorAll(".card.drop-before,.card.drop-after").forEach(function(c){c.classList.remove("drop-before","drop-after")});
        });
        card.addEventListener("dragover", function(e) {
          e.preventDefault();
          e.stopPropagation();
          var rect = card.getBoundingClientRect();
          var isAfter = e.clientY >= rect.top + rect.height / 2;
          card.classList.toggle("drop-before", !isAfter);
          card.classList.toggle("drop-after", isAfter);
        });
        card.addEventListener("dragleave", function() {
          card.classList.remove("drop-before", "drop-after");
        });
        card.addEventListener("click", function(e) {
          if(e.target.closest("[data-action]")) return;
          showDetail(t);
        });

        var actionsHtml = '<button class="card-action" data-action="detail" data-ticket="'+escapeAttr(t.id)+'" title="View ticket details">📄</button>';

        card.innerHTML =
          '<div class="drag-handle" title="Drag to move between lanes">⠿</div>' +
          '<div class="card-actions">'+actionsHtml+'</div>' +
          '<div class="card-title">'+escapeHtml(t.title)+'</div>' +
          '<div class="card-meta">' +
            '<span class="badge '+priorityClass(t.priority)+'">'+priorityIcon(t.priority)+' '+escapeHtml(t.priority)+'</span>' +
            (t.estimate?'<span class="badge badge-estimate">'+escapeHtml(t.estimate)+'</span>':'') +
            (t.quality?'<span class="quality-stars">'+qualityStars(t.quality)+'</span>':'') +
            (t.parseError?'<span class="badge badge-error">⚠ parse error</span>':'') +
            (t.completed?'<span class="badge badge-estimate">✅ '+escapeHtml(t.completed)+'</span>':'') +
            t.tags.map(function(tag){return '<span class="badge badge-tag">'+escapeHtml(tag)+'</span>'}).join('') +
          '</div>';

        body.appendChild(card);
      });
    }
    col.appendChild(body);
    container.appendChild(col);
  });
  el("total-count").textContent = total+" tickets";
}

function showDetail(ticket) {
  currentTicket = ticket;
  el("board-view").style.display = "none";
  el("toolbar").style.display = "none";
  el("detail-view").classList.add("active");
  el("detail-title").textContent = ticket.title;
  el("detail-id").textContent = ticket.id+" · "+ticket.laneLabel;

  el("detail-tags").innerHTML = ticket.tags.map(function(tag){
    return '<span class="badge badge-tag">'+escapeHtml(tag)+'</span> ';
  }).join('');

  var meta = [
    {label:"Priority",value:priorityIcon(ticket.priority)+" "+ticket.priority},
    {label:"Estimate",value:ticket.estimate||"—"},
    {label:"Quality",value:ticket.quality?qualityStars(ticket.quality)+" "+ticket.quality+"/10":"—"},
    {label:"Risk",value:ticket.risk||"—"},
    {label:"Created",value:ticket.created||"—"},
    {label:"Updated",value:ticket.updated||"—"},
    {label:"Completed",value:ticket.completed?"✅ "+ticket.completed:"—"},
    {label:"Target",value:ticket.targetRelease||"—"}
  ];
  el("detail-meta").innerHTML = meta.map(function(m){
    return '<div class="meta-item"><div class="meta-label">'+m.label+'</div><div class="meta-value">'+m.value+'</div></div>';
  }).join('');

  var sections = "";
  if(ticket.summary) sections+='<div class="detail-section"><h3>Summary</h3><div>'+renderMd(ticket.summary)+'</div></div>';
  if(ticket.acceptanceCriteriaRaw) {
    sections+='<div class="detail-section"><h3>Acceptance Criteria</h3><div style="max-height:300px;overflow-y:auto">'+renderMd(ticket.acceptanceCriteriaRaw)+'</div></div>';
  }
  // Parse references from body (strip code blocks first to avoid false matches)
  var refs = [];
  if(ticket.body) {
    var bodyNoCode = ticket.body;
    var refPatterns = [
      {re:new RegExp("(?:depends on|prerequisite)[: ]+([a-z0-9][a-z0-9._-]+)","gi"), type:"depends-on"},
      {re:new RegExp("(?:blocked by)[: ]+([a-z0-9][a-z0-9._-]+)","gi"), type:"blocked-by"},
      {re:new RegExp("(?:see workitem|see ticket)[: ]+([a-z0-9][a-z0-9._-]+)","gi"), type:"related"},
      {re:new RegExp("(?:follow-up)[: ]+([a-z0-9][a-z0-9._-]+)","gi"), type:"follow-up"},
      {re:new RegExp("workitem[: ]+([a-z0-9][a-z0-9._-]+)\\.md","gi"), type:"related"},
    ];
    refPatterns.forEach(function(p) {
      var m; while((m=p.re.exec(bodyNoCode))!==null) {
        var rid=m[1].replace(/\.md$/,"");
        if(rid!==ticket.id && !refs.find(function(r){return r.id===rid&&r.type===p.type}))
          refs.push({id:rid, type:p.type});
      }
    });
    // Also parse Prerequisites section for ticket references
    var prereqParts = ticket.body.split(/(?=^## )/m);
    prereqParts.forEach(function(part) {
      if(/^## prerequisites/i.test(part.trim())) {
        var lines = part.split("\\n");
        lines.forEach(function(line) {
          var m = line.match(new RegExp("^- +.?([a-z0-9][a-z0-9._-]+)"));
          if(m) {
            var rid = m[1];
            if(rid!==ticket.id && TICKETS.find(function(t){return t.id===rid}) && !refs.find(function(r){return r.id===rid}))
              refs.push({id:rid, type:"depends-on"});
          }
        });
      }
    });
  }
  if(refs.length>0) {
    var refRows = refs.map(function(r) {
      var found = TICKETS.find(function(t){return t.id===r.id});
      var status = found ? found.laneLabel : "not found";
      return '<tr><td><a href="#" data-action="detail" data-ticket="'+escapeAttr(r.id)+'">'+escapeHtml(r.id)+'</a></td><td>'+escapeHtml(r.type)+'</td><td>'+escapeHtml(status)+'</td></tr>';
    }).join("");
    sections += '<div class="detail-section"><h3>References</h3><table><tr><th>Ticket</th><th>Type</th><th>Status</th></tr>'+refRows+'</table></div>';
  }
  el("detail-sections").innerHTML = sections;

  var idx = laneIndex(ticket.laneKey);
  var strip = '<button class="lane-arrow" data-action="move-delta" data-delta="-1" title="Move to previous lane"'+(idx<=0?' disabled':'')+'>⬅</button>';
  LANES.forEach(function(lane){
    strip+='<button class="lane-pill'+(lane.key===ticket.laneKey?' active':'')+'" data-action="move-to" data-lane="'+escapeAttr(lane.key)+'" title="Move ticket to '+escapeHtml(lane.label)+'">' +escapeHtml(lane.label)+'</button>';
  });
  strip+='<button class="lane-arrow" data-action="move-delta" data-delta="1" title="Move to next lane"'+(idx>=LANES.length-1?' disabled':'')+'>➡</button>';
  el("lane-strip").innerHTML = strip;
}

function moveToLane(key) {
  if(!currentTicket||currentTicket.laneKey===key) return;
  moveTicket(currentTicket.id, key);
  currentTicket.laneKey = key;
  var l = LANES.find(function(x){return x.key===key});
  currentTicket.laneLabel = l?l.label:key;
  showDetail(currentTicket);
}
function moveLane(delta) {
  if(!currentTicket) return;
  var idx = laneIndex(currentTicket.laneKey)+delta;
  if(idx<0||idx>=LANES.length) return;
  moveToLane(LANES[idx].key);
}
function showBoard() {
  currentTicket = null;
  el("detail-view").classList.remove("active");
  el("board-view").style.display = "flex";
  el("toolbar").style.display = "flex";
  renderBoard();
}

/* Event delegation — no inline onclick anywhere */
document.addEventListener("click", function(e) {
  var cmd = e.target.closest("[data-cmd]");
  if(cmd){ sendCmd(cmd.dataset.cmd); return; }

  var action = e.target.closest("[data-action]");
  if(action) {
    e.stopPropagation();
    var act = action.dataset.action;
    if(act==="detail") {
      var t = TICKETS.find(function(x){return x.id===action.dataset.ticket});
      if(t) showDetail(t);
    } else if(act==="move-to") {
      moveToLane(action.dataset.lane);
    } else if(act==="move-delta") {
      moveLane(parseInt(action.dataset.delta,10));
    }
    return;
  }

  if(e.target.closest("#back-btn")){ showBoard(); return; }
  if(e.target.closest("#refresh-btn")){ refreshBoard(); return; }
  if(e.target.closest("#theme-toggle")){ toggleTheme(); return; }
  if(e.target.closest("#refine-btn")&&currentTicket){ sendCmd("refine and score workitem "+currentTicket.id+" in workitems/"+currentLaneDir()+"/"+currentTicket.filename+".md"); return; }
});

function toggleTheme() {
  var html = document.documentElement;
  var current = html.getAttribute("data-theme");
  var next;
  if(current === "dark") next = "light";
  else if(current === "light") next = "dark";
  else next = window.matchMedia("(prefers-color-scheme: light)").matches ? "dark" : "light";
  html.setAttribute("data-theme", next);
  try { localStorage.setItem("board-theme", next); } catch(e) {}
  el("theme-toggle").textContent = next === "dark" ? "🌓" : "☀️";
}

(function initTheme() {
  var theme;
  try { theme = localStorage.getItem("board-theme"); } catch(e) {}
  if(theme !== "dark" && theme !== "light") {
    theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", theme);
  el("theme-toggle").textContent = theme === "dark" ? "🌓" : "☀️";
})();

renderBoard();
if(IS_FULL_PAGE) {
  el("refresh-btn").style.display = "";
  refreshBoard();
}
`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="icon" href="/favicon.ico"><link rel="icon" type="image/png" sizes="192x192" href="/static/icon-192.png"><title>📋 Kanban Board</title><script src="/static/js/marked.min.js"><\/script><style>${CSS}</style></head><body>
<div class="toolbar" id="toolbar">
  <h1>📋 Board <span class="count" id="total-count"></span></h1>
  <button class="btn" data-cmd="board review" title="Ask the agent to audit the board and suggest next actions">📊 Review Board</button>
  <button class="btn" data-cmd="create new workitem" title="Ask the agent to create a new ticket">➕ New Ticket</button>
  <button class="btn" data-cmd="generate board SVG and post it" title="Export the board as an SVG image">🖼️ Export SVG</button>
  <button class="btn" id="refresh-btn" title="Refresh board with current workspace data" style="display:none">🔄 Refresh</button>
  <a class="btn" href="/board-page" target="_blank" title="Open board in a full browser tab with live refresh" style="text-decoration:none">🔗 Open in Tab</a>
  <button class="btn" id="theme-toggle" title="Toggle light/dark theme">🌓</button>
</div>
<div class="board" id="board-view"></div>
<div class="detail-view" id="detail-view">
  <div style="margin-bottom:12px"><button class="btn" id="back-btn" title="Return to the board view">← Back to Board</button></div>
  <div class="lane-strip" id="lane-strip"></div>
  <div class="detail-header">
    <div class="detail-title" id="detail-title"></div>
    <div class="detail-id" id="detail-id"></div>
    <div id="detail-tags" style="margin-top:6px"></div>
  </div>
  <div class="detail-meta" id="detail-meta"></div>
  <div id="detail-sections"></div>
  <div style="margin-top:16px;display:flex;gap:8px">
    <button class="btn" id="refine-btn" title="Ask the agent to refine this ticket">✏️ Refine</button>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>${JS}</script>
</body></html>`;
}

/* ── Extension entry point ────────────────────────────────────────── */

const registerRoute = (globalThis as Record<string, unknown>).__piclaw_registerRoute as
  ((prefix: string, handler: (req: Request, pathname: string) => Response | Promise<Response> | null, ext: string) => void) | undefined;

export default function (pi: ExtensionAPI) {
  const workitemsDir = join(process.cwd(), "workitems");

  /* ── HTTP API routes ── */
  if (registerRoute) {
    // GET /api/board → live ticket JSON
    registerRoute("/api/board", (req: Request, pathname: string) => {
      if (req.method === "POST" && pathname === "/api/board/move") {
        return handleMove(req, workitemsDir);
      }
      if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const board = scanBoard(workitemsDir);
      const allTickets: Ticket[] = [];
      for (const tickets of board.values()) allTickets.push(...tickets);
      return new Response(JSON.stringify({ tickets: allTickets, lanes: LANES }), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }, "kanban-board-widget");

    // GET /board-page → full HTML board page
    registerRoute("/board-page", (_req: Request, _pathname: string) => {
      const board = scanBoard(workitemsDir);
      const html = buildWidgetHTML(board);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }, "kanban-board-widget");
  }

  pi.registerCommand("board", {
    description: "Open the interactive kanban board widget",
    handler: async (args, _ctx) => {
      const board = scanBoard(workitemsDir);

      const totalTickets = Array.from(board.values()).reduce((n, t) => n + t.length, 0);
      if (registerRoute) {
        pi.sendMessage({
          customType: "kanban-board",
          content: `📋 Board ready — ${totalTickets} tickets. Open /board-page in your browser.`,
          display: true,
        });
      } else {
        pi.sendMessage({
          customType: "kanban-board",
          content: `📋 Board ready — ${totalTickets} tickets. Note: /board-page requires route registration (PiClaw).`,
          display: true,
        });
      }
    },
  });
}
/* ── Move API handler ── */

async function handleMove(req: Request, workitemsDir: string): Promise<Response> {
  try {
    const body = await req.json() as { id?: string; to?: string };
    const ticketId = body.id?.trim();
    const toLane = body.to?.trim();
    if (!ticketId || !toLane) {
      return new Response(JSON.stringify({ error: "Missing id or to" }), { status: 400 });
    }
    // Path traversal protection: ticket ID must be a simple slug
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(ticketId)) {
      return new Response(JSON.stringify({ error: "Invalid ticket id" }), { status: 400 });
    }
    const targetLane = LANES.find((l) => l.key === toLane);
    if (!targetLane) {
      return new Response(JSON.stringify({ error: `Unknown lane: ${toLane}` }), { status: 400 });
    }

    // Find the ticket file
    let sourceFile: string | null = null;
    let sourceLaneDir: string | null = null;
    for (const lane of LANES) {
      const dir = join(workitemsDir, lane.dir);
      const candidate = join(dir, ticketId + ".md");
      if (existsSync(candidate)) {
        sourceFile = candidate;
        sourceLaneDir = lane.dir;
        break;
      }
    }
    if (!sourceFile || !sourceLaneDir) {
      return new Response(JSON.stringify({ error: `Ticket not found: ${ticketId}` }), { status: 404 });
    }

    const targetDir = join(workitemsDir, targetLane.dir);
    mkdirSync(targetDir, { recursive: true });
    const targetFile = join(targetDir, ticketId + ".md");
    renameSync(sourceFile, targetFile);

    // Update front matter: status and updated date
    try {
      let content = readFileSync(targetFile, "utf-8");
      content = content.replace(/^status:\s*.+$/m, `status: ${targetLane.key}`);
      const today = new Date().toISOString().slice(0, 10);
      content = content.replace(/^updated:\s*.+$/m, `updated: ${today}`);
      writeFileSync(targetFile, content, "utf-8");
    } catch { /* best effort */ }

    return new Response(JSON.stringify({ ok: true, id: ticketId, from: sourceLaneDir, to: targetLane.dir }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    return new Response(JSON.stringify({ error: (e instanceof Error ? e.message : String(e)) }), { status: 500 });
  }
}
