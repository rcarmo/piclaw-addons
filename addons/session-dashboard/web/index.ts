// @ts-nocheck
const ADDON_ID = "session-dashboard";
const API = `/agent/addons/api/${ADDON_ID}/sessions`;
const STORAGE_OPEN = "piclaw:session-dashboard:open";
const STORAGE_LIMIT = "piclaw:session-dashboard:limit";
const DEFAULT_LIMIT = 8;
const DEFAULT_CHAT_JID = "web:default";

if (!globalThis.__piclawSessionDashboardInstalled) {
  globalThis.__piclawSessionDashboardInstalled = true;
  installSessionDashboard();
}

export function installSessionDashboard() {
  if (typeof document === "undefined") return null;

  const state = {
    open: localStorage.getItem(STORAGE_OPEN) === "true",
    limit: clampNumber(Number(localStorage.getItem(STORAGE_LIMIT)) || DEFAULT_LIMIT, 1, 12),
    currentChatJid: getCurrentChatJid(),
    sessions: [],
    activeByJid: new Map(),
    contextByJid: new Map(),
    loading: false,
    error: "",
    lastGeneratedAt: null,
    pollTimer: null,
    panelResizeObserver: null,
    refreshQueued: false,
  };

  injectStyles();

  const root = document.createElement("div");
  root.className = "session-dashboard-root";
  root.innerHTML = `
    <button class="session-dashboard-toggle" type="button" aria-label="Show sessions" title="Show sessions">
      <span class="session-dashboard-toggle-dot" aria-hidden="true"></span>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 6 8 10 12 6" /></svg>
    </button>
    <section class="session-dashboard-panel" aria-label="Recent active sessions">
      <header class="session-dashboard-header">
        <div>
          <div class="session-dashboard-title">Active sessions</div>
          <div class="session-dashboard-subtitle"></div>
        </div>
        <div class="session-dashboard-actions">
          <button class="session-dashboard-refresh" type="button">Refresh</button>
          <button class="session-dashboard-close" type="button" aria-label="Hide sessions">×</button>
        </div>
      </header>
      <div class="session-dashboard-grid" role="list"></div>
      <footer class="session-dashboard-footer" aria-live="polite"></footer>
    </section>
  `;
  document.body.appendChild(root);

  const toggle = root.querySelector(".session-dashboard-toggle");
  const panel = root.querySelector(".session-dashboard-panel");
  const subtitle = root.querySelector(".session-dashboard-subtitle");
  const grid = root.querySelector(".session-dashboard-grid");
  const footer = root.querySelector(".session-dashboard-footer");
  const refreshButton = root.querySelector(".session-dashboard-refresh");
  const closeButton = root.querySelector(".session-dashboard-close");

  function setOpen(next) {
    state.open = Boolean(next);
    localStorage.setItem(STORAGE_OPEN, state.open ? "true" : "false");
    render();
    schedulePolling();
    if (state.open) void refreshNow("open");
  }

  function schedulePolling() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (!state.open) return;
    state.pollTimer = setTimeout(async () => {
      await refreshNow("poll").catch(() => undefined);
      schedulePolling();
    }, 5000);
    state.pollTimer.unref?.();
  }

  async function refreshNow(reason = "manual") {
    if (!state.open) return;
    if (state.loading) {
      state.refreshQueued = true;
      return;
    }
    state.loading = true;
    state.error = "";
    renderChrome();
    try {
      const [recentPayload, activePayload] = await Promise.all([
        apiJson(`${API}?limit=${encodeURIComponent(state.limit)}`),
        apiJson("/agent/active-chats").catch(() => ({ chats: [] })),
      ]);
      state.activeByJid = new Map((activePayload?.chats || []).filter((chat) => chat?.chat_jid).map((chat) => [chat.chat_jid, chat]));
      state.lastGeneratedAt = recentPayload?.generated_at || new Date().toISOString();
      state.sessions = mergeSessions(recentPayload?.sessions || [], [...state.activeByJid.values()], state.limit);
      render();
      await refreshContexts();
      render();
    } catch (error) {
      state.error = String(error?.message || error);
      render();
    } finally {
      state.loading = false;
      renderChrome();
      if (state.refreshQueued) {
        state.refreshQueued = false;
        setTimeout(() => void refreshNow("queued"), 50);
      }
    }
  }

  async function refreshContexts() {
    const visible = state.sessions.slice(0, state.limit);
    const entries = await Promise.all(visible.map(async (session) => {
      try {
        const context = await apiJson(`/agent/context?chat_jid=${encodeURIComponent(session.chat_jid)}`);
        return [session.chat_jid, normalizeContext(context)];
      } catch {
        return [session.chat_jid, null];
      }
    }));
    state.contextByJid = new Map(entries);
  }

  function renderChrome() {
    state.currentChatJid = getCurrentChatJid();
    root.classList.toggle("open", state.open);
    root.classList.toggle("loading", state.loading);
    toggle.title = state.open ? "Hide sessions" : "Show recent sessions";
    toggle.setAttribute("aria-label", state.open ? "Hide sessions" : "Show recent sessions");
    toggle.setAttribute("aria-expanded", state.open ? "true" : "false");
    panel.setAttribute("aria-hidden", state.open ? "false" : "true");
    refreshButton.disabled = state.loading;
    if (state.open) requestAnimationFrame(updatePanelHeight);
  }

  function updatePanelHeight() {
    root.style.setProperty("--session-dashboard-panel-height", `${Math.ceil(panel.getBoundingClientRect().height)}px`);
  }

  function render() {
    renderChrome();
    const activeCount = state.sessions.filter((session) => isSessionActive(session, state.activeByJid.get(session.chat_jid))).length;
    subtitle.textContent = state.error
      ? "Unable to load sessions"
      : `${state.sessions.length || state.limit} slots • ${activeCount} active • ${state.currentChatJid}`;
    footer.textContent = state.error
      ? state.error
      : state.lastGeneratedAt ? `Updated ${formatRelativeTime(state.lastGeneratedAt)}` : "Waiting for session data…";
    grid.textContent = "";
    if (!state.sessions.length) {
      const empty = document.createElement("div");
      empty.className = "session-dashboard-empty";
      empty.textContent = state.loading ? "Loading sessions…" : "No recent sessions found.";
      grid.appendChild(empty);
      return;
    }
    for (const session of state.sessions) grid.appendChild(renderTile(session));
  }

  function renderTile(session) {
    const active = state.activeByJid.get(session.chat_jid);
    const context = state.contextByJid.get(session.chat_jid);
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "session-dashboard-tile";
    tile.classList.toggle("current", session.chat_jid === state.currentChatJid);
    tile.classList.toggle("active", isSessionActive(session, active));
    tile.role = "listitem";
    tile.title = `Open ${session.chat_jid}`;
    tile.addEventListener("click", (event) => navigateToSession(session.chat_jid, event));

    const top = document.createElement("div");
    top.className = "session-dashboard-tile-top";
    const name = document.createElement("div");
    name.className = "session-dashboard-name";
    name.textContent = `@${session.agent_name || agentNameFromChatJid(session.chat_jid)}`;
    const status = document.createElement("span");
    status.className = "session-dashboard-status";
    status.textContent = formatStatus(active);
    top.append(name, status);

    const meta = document.createElement("div");
    meta.className = "session-dashboard-meta";
    meta.textContent = `${formatRelativeTime(session.last_active_at)} • ${session.chat_jid}`;

    const summary = document.createElement("div");
    summary.className = "session-dashboard-summary";
    summary.textContent = session.summary || "No recent output yet.";

    const contextRow = document.createElement("div");
    contextRow.className = "session-dashboard-context";
    const label = document.createElement("span");
    label.textContent = formatContext(context);
    const meter = document.createElement("span");
    meter.className = "session-dashboard-context-meter";
    const fill = document.createElement("span");
    fill.style.width = `${clampNumber(Math.round(context?.percent || 0), 0, 100)}%`;
    meter.appendChild(fill);
    contextRow.append(label, meter);

    tile.append(top, meta, summary, contextRow);
    return tile;
  }

  function handleLiveEvent(event) {
    if (!state.open) return;
    const detail = event?.detail || {};
    const payload = detail.payload || detail;
    if (payload?.chat_jid && payload.chat_jid !== state.currentChatJid && !state.activeByJid.has(payload.chat_jid)) return;
    if (payload?.key === "context_usage" && payload?.chat_jid) {
      state.contextByJid.set(payload.chat_jid, normalizeContext(payload.context_usage || safeJson(payload.text)));
      render();
      return;
    }
    setTimeout(() => void refreshNow("event"), 100);
  }

  function handleCurrentChatChanged() {
    state.currentChatJid = getCurrentChatJid();
    render();
  }

  function handleKeydown(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isEditableTarget(event.target, event.composedPath?.())) return;
    if (event.key === "Escape" && state.open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "`" || event.key === "~") {
      event.preventDefault();
      setOpen(!state.open);
    }
  }

  toggle.addEventListener("click", () => setOpen(!state.open));
  closeButton.addEventListener("click", () => setOpen(false));
  refreshButton.addEventListener("click", () => void refreshNow("manual"));
  window.addEventListener("piclaw:current-chat-changed", handleCurrentChatChanged);
  window.addEventListener("popstate", handleCurrentChatChanged);
  window.addEventListener("piclaw-extension-ui", handleLiveEvent);
  window.addEventListener("piclaw-extension-ui:status", handleLiveEvent);
  window.addEventListener("focus", () => { if (state.open) void refreshNow("focus"); });
  document.addEventListener("keydown", handleKeydown);
  if (typeof ResizeObserver !== "undefined") {
    state.panelResizeObserver = new ResizeObserver(updatePanelHeight);
    state.panelResizeObserver.observe(panel);
  }

  render();
  updatePanelHeight();
  schedulePolling();
  if (state.open) void refreshNow("startup");
  return { root, refreshNow, destroy: () => { if (state.pollTimer) clearTimeout(state.pollTimer); state.panelResizeObserver?.disconnect?.(); document.removeEventListener("keydown", handleKeydown); root.remove(); } };
}

const EDITABLE_SHORTCUT_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='textbox']",
  "[aria-multiline='true']",
  ".compose-box",
  ".compose-model-popup",
  ".compose-session-popup",
  ".settings-dialog",
  ".workspace-sidebar",
  ".editor-pane-container",
  ".dock-panel",
  ".timeline-menu-dropdown",
  ".rename-branch-overlay",
  ".agent-request-modal",
  ".attachment-preview-modal",
  ".adaptive-card-container",
  ".vnc-pane-shell",
  ".kanban-plugin",
  ".cm-editor",
  ".cm-content",
  ".monaco-editor",
  ".ProseMirror",
  "[data-no-session-dashboard-shortcut]",
].join(",");

function isEditableTarget(target, path = []) {
  const candidates = Array.isArray(path) && path.length ? path : [target];
  for (const candidate of candidates) {
    const element = candidate instanceof Element ? candidate : null;
    if (!element) continue;
    if (element.isContentEditable) return true;
    if (element.closest(EDITABLE_SHORTCUT_SELECTOR)) return true;
  }
  return false;
}

function mergeSessions(recent, active, limit) {
  const byJid = new Map();
  for (const session of recent) {
    if (!session?.chat_jid) continue;
    byJid.set(session.chat_jid, { ...session });
  }
  for (const chat of active) {
    if (!chat?.chat_jid) continue;
    const existing = byJid.get(chat.chat_jid) || {};
    byJid.set(chat.chat_jid, {
      chat_jid: chat.chat_jid,
      agent_name: chat.agent_name || existing.agent_name || agentNameFromChatJid(chat.chat_jid),
      root_chat_jid: chat.root_chat_jid || existing.root_chat_jid || null,
      branch_id: chat.branch_id || existing.branch_id || null,
      last_active_at: chat.last_activity_at || chat.last_event_at || existing.last_active_at || null,
      summary: existing.summary || chat.summary || "No recent output yet.",
      message_count: existing.message_count || 0,
      is_archived: Boolean(existing.is_archived),
      model: chat.model || existing.model || null,
    });
  }
  return [...byJid.values()]
    .sort((left, right) => {
      const leftActive = activeStateScore(left, active.find((chat) => chat.chat_jid === left.chat_jid));
      const rightActive = activeStateScore(right, active.find((chat) => chat.chat_jid === right.chat_jid));
      if (leftActive !== rightActive) return rightActive - leftActive;
      return Date.parse(right.last_active_at || "") - Date.parse(left.last_active_at || "");
    })
    .slice(0, limit);
}

function activeStateScore(session, active) {
  if (!active) return 0;
  if (active.activity_status === "streaming") return 3;
  if (active.activity_status === "working" || active.activity_status === "busy") return 2;
  if (active.is_active || session.is_active) return 1;
  return 0;
}

function isSessionActive(session, active) {
  return activeStateScore(session, active) > 0;
}

function formatStatus(active) {
  if (!active) return "idle";
  if (active.activity_status) return String(active.activity_status).replace(/_/g, " ");
  return active.is_active ? "active" : "idle";
}

function normalizeContext(context) {
  if (!context || typeof context !== "object") return null;
  const percent = Number(context.percent);
  const tokens = Number(context.tokens);
  const contextWindow = Number(context.contextWindow);
  return {
    percent: Number.isFinite(percent) ? percent : null,
    tokens: Number.isFinite(tokens) ? tokens : null,
    contextWindow: Number.isFinite(contextWindow) ? contextWindow : null,
  };
}

function formatContext(context) {
  if (!context || context.percent == null) return "context unknown";
  return `${Math.round(context.percent)}% context`;
}

function navigateToSession(chatJid, event) {
  const url = new URL(globalThis.location?.href || "http://localhost/");
  url.searchParams.set("chat_jid", chatJid);
  url.searchParams.delete("branch_loader");
  url.searchParams.delete("pane_popout");
  if (event?.metaKey || event?.ctrlKey || event?.button === 1) {
    window.open(url.toString(), "_blank", "noopener");
    return;
  }
  window.location.href = url.toString();
}

async function apiJson(url, options) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `${response.status} ${response.statusText}`);
  return payload;
}

function getCurrentChatJid() {
  const fromApi = normalizeChatJid(globalThis.__piclaw_web?.getCurrentChatJid?.());
  if (fromApi !== DEFAULT_CHAT_JID) return fromApi;
  const fromGlobal = normalizeChatJid(globalThis.__piclawCurrentChatJid);
  if (fromGlobal !== DEFAULT_CHAT_JID) return fromGlobal;
  try {
    const url = new URL(globalThis.location?.href || "https://example.test/");
    return normalizeChatJid(url.searchParams.get("chat_jid"));
  } catch {
    return DEFAULT_CHAT_JID;
  }
}

function normalizeChatJid(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || DEFAULT_CHAT_JID;
}

function agentNameFromChatJid(chatJid) {
  const suffix = String(chatJid || "").split(":").pop() || "session";
  return suffix.replace(/[^a-zA-Z0-9._-]+/g, "-") || "session";
}

function formatRelativeTime(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "never";
  const delta = Date.now() - time;
  if (delta < 30_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function safeJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function injectStyles() {
  if (document.getElementById("session-dashboard-styles")) return;
  const style = document.createElement("style");
  style.id = "session-dashboard-styles";
  style.textContent = `
    .session-dashboard-root {
      position: fixed;
      inset: 0 0 auto 0;
      z-index: 118;
      pointer-events: none;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text-primary,#e5e7eb);
      --session-dashboard-max-width: 1180px;
      --session-dashboard-panel-height: 0px;
    }
    .session-dashboard-toggle {
      pointer-events: auto;
      position: fixed;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      z-index: 120;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      width: 34px;
      min-height: 24px;
      padding: 0;
      border: 1px solid var(--border-color, rgba(148,163,184,.35));
      border-top: 0;
      border-radius: 0 0 var(--radius-md, 8px) var(--radius-md, 8px);
      background: var(--bg-secondary,#111827);
      color: var(--text-secondary,#cbd5e1);
      box-shadow: none;
      cursor: pointer;
      font-size: 11px;
      line-height: 1;
      transition: transform var(--ui-transition-fast, .18s), background-color var(--ui-transition-fast, .18s), color var(--ui-transition-fast, .18s), border-color var(--ui-transition-fast, .18s);
    }
    .session-dashboard-root.open .session-dashboard-toggle {
      transform: translate(-50%, var(--session-dashboard-panel-height));
      background: var(--bg-primary,#0b1020);
      color: var(--text-primary,#f8fafc);
      border-color: var(--border-color, rgba(148,163,184,.28));
      border-top: 0;
    }
    .session-dashboard-toggle:hover { color: var(--text-primary,#f8fafc); border-color: var(--accent-color,#2563eb); }
    .session-dashboard-toggle svg { width: 12px; height: 12px; flex-shrink: 0; transition: transform var(--ui-transition-fast, .18s); }
    .session-dashboard-root.open .session-dashboard-toggle svg { transform: rotate(180deg); }
    .session-dashboard-toggle-dot {
      width: 3px;
      height: 14px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--border-color, rgba(148,163,184,.45)) 72%, transparent);
    }
    .session-dashboard-root.loading .session-dashboard-toggle-dot { background: var(--accent-color,#2563eb); }
    .session-dashboard-panel {
      pointer-events: auto;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 119;
      max-height: min(58vh, 520px);
      padding: calc(10px + env(safe-area-inset-top)) 10px 10px;
      box-sizing: border-box;
      background: var(--bg-primary,#0b1020);
      border-bottom: 1px solid var(--border-color, rgba(148,163,184,.28));
      box-shadow: none;
      transform: translateY(-100%);
      transition: transform .18s ease;
      overflow: hidden auto;
      color: var(--text-primary,#e5e7eb);
    }
    .session-dashboard-panel::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: -18px;
      height: 18px;
      pointer-events: none;
      opacity: 0;
      background: linear-gradient(to bottom, rgba(0,0,0,.16), rgba(0,0,0,0));
      transition: opacity .18s ease;
    }
    .session-dashboard-root.open .session-dashboard-panel { transform: translateY(0); }
    .session-dashboard-root.open .session-dashboard-panel::after { opacity: 1; }
    .session-dashboard-header {
      min-height: 34px;
      margin: 0 auto 10px;
      max-width: var(--session-dashboard-max-width);
      padding: 5px 10px;
      box-sizing: border-box;
      border: 1px solid var(--border-color, rgba(148,163,184,.25));
      border-radius: var(--radius-md, 8px);
      background: var(--bg-secondary,#111827);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .session-dashboard-title { font-weight: 650; font-size: 12px; letter-spacing: .01em; }
    .session-dashboard-subtitle, .session-dashboard-footer { color: var(--text-secondary,#94a3b8); font-size: 10px; }
    .session-dashboard-actions { display: flex; gap: 8px; align-items: center; }
    .session-dashboard-actions button {
      border: 1px solid var(--border-color, rgba(148,163,184,.28));
      border-radius: 8px;
      padding: 6px 10px;
      background: var(--bg-primary,#0b1020);
      color: var(--text-primary,#e5e7eb);
      cursor: pointer;
      font-size: 12px;
    }
    .session-dashboard-actions button:disabled { opacity: .45; cursor: default; }
    .session-dashboard-close { font-size: 18px; line-height: 1; min-width: 32px; padding: 4px 8px !important; }
    .session-dashboard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(230px, 100%), 1fr));
      gap: 8px;
      max-width: var(--session-dashboard-max-width);
      margin: 0 auto;
    }
    .session-dashboard-tile {
      min-height: 126px;
      text-align: left;
      border: 1px solid var(--border-color, rgba(148,163,184,.25));
      border-radius: var(--radius-md, 8px);
      padding: 10px;
      background: var(--bg-secondary,#111827);
      color: inherit;
      cursor: pointer;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      gap: 7px;
      transition: background-color var(--ui-transition-fast, .18s), border-color var(--ui-transition-fast, .18s), color var(--ui-transition-fast, .18s);
    }
    .session-dashboard-tile:hover { border-color: var(--accent-color,#2563eb); color: var(--text-primary,#f8fafc); }
    .session-dashboard-tile.current { border-color: var(--accent-color,#2563eb); background: color-mix(in srgb, var(--accent-color,#2563eb) 8%, var(--bg-secondary,#111827)); }
    .session-dashboard-tile.active .session-dashboard-status::before { background: var(--success-color,#22c55e); }
    .session-dashboard-tile-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .session-dashboard-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; font-size: 12px; }
    .session-dashboard-status { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary,#94a3b8); font-size: 10px; white-space: nowrap; }
    .session-dashboard-status::before { content: ""; width: 7px; height: 7px; border-radius: 999px; background: var(--text-secondary,#64748b); opacity: .8; }
    .session-dashboard-meta { color: var(--text-secondary,#94a3b8); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-dashboard-summary { color: var(--text-primary,#e5e7eb); font-size: 12px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .session-dashboard-context { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--text-secondary,#94a3b8); font-size: 10px; }
    .session-dashboard-context-meter { flex: 1; height: 5px; max-width: 90px; border-radius: 999px; background: color-mix(in srgb, var(--border-color, rgba(148,163,184,.35)) 72%, transparent); overflow: hidden; }
    .session-dashboard-context-meter span { display: block; height: 100%; border-radius: inherit; background: var(--accent-color,#2563eb); }
    .session-dashboard-footer { max-width: var(--session-dashboard-max-width); margin: 10px auto 0; min-height: 16px; }
    .session-dashboard-empty { grid-column: 1 / -1; border: 1px dashed var(--border-color, rgba(148,163,184,.35)); border-radius: var(--radius-md, 8px); padding: 18px; text-align: center; color: var(--text-secondary,#94a3b8); }
    @media (max-width: 720px) { .session-dashboard-panel { max-height: 72vh; } .session-dashboard-grid { grid-template-columns: 1fr; } .session-dashboard-header { align-items: flex-start; } }
  `;
  document.head.appendChild(style);
}

export const __sessionDashboardTest = {
  mergeSessions,
  isEditableTarget,
  normalizeContext,
  formatContext,
  formatRelativeTime,
  agentNameFromChatJid,
};
