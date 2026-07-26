// @ts-nocheck
const ADDON_ID = "session-dashboard";
const API = `/agent/addons/api/${ADDON_ID}/sessions`;
const STORAGE_OPEN = "piclaw:session-dashboard:open";
const DEFAULT_LIMIT = 8;
const DEFAULT_CHAT_JID = "web:default";
const NARROW_LAYOUT_MAX_WIDTH = 759;
const MEDIUM_LAYOUT_MAX_WIDTH = 1079;
const RESIZE_DEBOUNCE_MS = 150;
const DASHBOARD_REFRESH_INTERVAL_MS = 15000;
const FOOTER_CLOCK_INTERVAL_MS = 1000;
const LIVE_REFRESH_DEBOUNCE_MS = 1000;
const PREVIEW_REFRESH_INTERVAL_MS = 3000;
const PREVIEW_MAX_LENGTH = 220;

if (!globalThis.__piclawSessionDashboardInstalled) {
  globalThis.__piclawSessionDashboardInstalled = true;
  installSessionDashboard();
}

export function installSessionDashboard() {
  if (typeof document === "undefined") return null;

  const initialLayout = resolveDashboardLayout(globalThis.innerWidth);
  const state = {
    open: localStorage.getItem(STORAGE_OPEN) === "true",
    limit: initialLayout.limit,
    columns: initialLayout.columns,
    currentChatJid: getCurrentChatJid(),
    sessions: [],
    activeByJid: new Map(),
    contextByJid: new Map(),
    previewByJid: new Map(),
    retainedLivePreviewByJid: new Map(),
    loading: false,
    previewLoading: false,
    error: "",
    lastGeneratedAt: null,
    pollTimer: null,
    previewTimer: null,
    footerClockTimer: null,
    liveRefreshTimer: null,
    resizeTimer: null,
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
      <div class="session-dashboard-grid" role="list"></div>
      <footer class="session-dashboard-footer" aria-live="polite">
        <span class="session-dashboard-footer-status"></span>
        <button class="session-dashboard-refresh" type="button">Refresh</button>
      </footer>
    </section>
  `;
  document.body.appendChild(root);

  const toggle = root.querySelector(".session-dashboard-toggle");
  const panel = root.querySelector(".session-dashboard-panel");
  const grid = root.querySelector(".session-dashboard-grid");
  const footerStatus = root.querySelector(".session-dashboard-footer-status");
  const refreshButton = root.querySelector(".session-dashboard-refresh");

  function setOpen(next) {
    state.open = Boolean(next);
    localStorage.setItem(STORAGE_OPEN, state.open ? "true" : "false");
    render();
    schedulePolling();
    schedulePreviewPolling();
    scheduleFooterClock();
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
    }, DASHBOARD_REFRESH_INTERVAL_MS);
    state.pollTimer.unref?.();
  }

  function scheduleFooterClock() {
    if (state.footerClockTimer) {
      clearTimeout(state.footerClockTimer);
      state.footerClockTimer = null;
    }
    if (!state.open) return;
    state.footerClockTimer = setTimeout(() => {
      renderFooter();
      scheduleFooterClock();
    }, FOOTER_CLOCK_INTERVAL_MS);
    state.footerClockTimer.unref?.();
  }

  function schedulePreviewPolling() {
    if (state.previewTimer) {
      clearTimeout(state.previewTimer);
      state.previewTimer = null;
    }
    if (!state.open) return;
    state.previewTimer = setTimeout(async () => {
      await refreshSessionPreviews("preview-poll").catch(() => undefined);
      schedulePreviewPolling();
    }, PREVIEW_REFRESH_INTERVAL_MS);
    state.previewTimer.unref?.();
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
        apiJson("/agent/active-chats").catch(() => null),
      ]);
      state.activeByJid = reconcileActiveChats(state.activeByJid, activePayload);
      state.lastGeneratedAt = recentPayload?.generated_at || new Date().toISOString();
      state.sessions = mergeSessions(recentPayload?.sessions || [], [...state.activeByJid.values()], state.limit);
      render();
      await Promise.all([
        refreshContexts(),
        refreshSessionPreviews("refresh", { renderOnChange: false }),
      ]);
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

  async function refreshSessionPreviews(reason = "preview", options = {}) {
    if (!state.open || state.previewLoading) return;
    const visible = state.sessions.slice(0, state.limit);
    const activeVisible = visible.filter((session) => isSessionActive(session, state.activeByJid.get(session.chat_jid)));
    const visibleJids = new Set(visible.map((session) => session.chat_jid));
    const activeVisibleJids = new Set(activeVisible.map((session) => session.chat_jid));
    const next = new Map(state.previewByJid);
    const retained = new Map(state.retainedLivePreviewByJid);
    for (const jid of new Set([...next.keys(), ...retained.keys()])) {
      if (!visibleJids.has(jid) || !activeVisibleJids.has(jid)) {
        next.delete(jid);
        retained.delete(jid);
      }
    }
    if (!activeVisible.length) {
      state.retainedLivePreviewByJid = retained;
      if (!previewMapsEqual(state.previewByJid, next)) {
        state.previewByJid = next;
        if (options.renderOnChange !== false) render();
      }
      return;
    }

    state.previewLoading = true;
    try {
      const entries = await Promise.all(activeVisible.map(async (session) => {
        try {
          const status = await apiJson(`/agent/status?chat_jid=${encodeURIComponent(session.chat_jid)}`);
          return [session.chat_jid, { ok: true, status }];
        } catch {
          return [session.chat_jid, { ok: false, status: null }];
        }
      }));
      const reconciled = reconcileStatusPreviewResults(next, retained, entries);
      state.retainedLivePreviewByJid = reconciled.retained;
      for (const jid of new Set([...next.keys(), ...reconciled.previews.keys()])) {
        if (reconciled.previews.has(jid)) next.set(jid, reconciled.previews.get(jid));
        else next.delete(jid);
      }
      if (!previewMapsEqual(state.previewByJid, next)) {
        state.previewByJid = next;
        if (options.renderOnChange !== false) render();
      }
    } finally {
      state.previewLoading = false;
    }
  }

  function renderChrome() {
    state.currentChatJid = getCurrentChatJid();
    root.style.setProperty("--session-dashboard-columns", String(state.columns));
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

  function renderFooter() {
    const visibleSessions = state.sessions.slice(0, state.limit);
    const activeCount = visibleSessions.filter((session) => isSessionActive(session, state.activeByJid.get(session.chat_jid))).length;
    if (state.error) {
      footerStatus.textContent = state.error;
      return;
    }
    const summary = `${state.limit} slots • ${activeCount} active • ${state.currentChatJid}`;
    footerStatus.textContent = state.lastGeneratedAt
      ? `${summary} • Updated ${formatRelativeTime(state.lastGeneratedAt)}`
      : `${summary} • Waiting for session data…`;
  }

  function render() {
    renderChrome();
    const visibleSessions = state.sessions.slice(0, state.limit);
    const activeCount = visibleSessions.filter((session) => isSessionActive(session, state.activeByJid.get(session.chat_jid))).length;
    const activeFill = activeFillPercent(activeCount, state.limit);
    root.style.setProperty("--session-dashboard-active-fill", `${activeFill}%`);
    toggle.title = state.open ? `Hide sessions (${activeCount} active)` : `Show recent sessions (${activeCount} active)`;
    toggle.setAttribute("aria-label", toggle.title);
    renderFooter();
    grid.textContent = "";
    if (!state.sessions.length) {
      const empty = document.createElement("div");
      empty.className = "session-dashboard-empty";
      empty.textContent = state.loading ? "Loading sessions…" : "No recent sessions found.";
      grid.appendChild(empty);
      return;
    }
    for (const session of visibleSessions) grid.appendChild(renderTile(session));
  }

  function renderTile(session) {
    const active = state.activeByJid.get(session.chat_jid);
    const context = state.contextByJid.get(session.chat_jid);
    const preview = state.previewByJid.get(session.chat_jid);
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
    if (preview) {
      const previewLabel = document.createElement("span");
      previewLabel.className = "session-dashboard-preview-label";
      previewLabel.textContent = preview.label;
      const previewText = document.createElement("span");
      previewText.className = "session-dashboard-preview-text";
      previewText.classList.toggle("tool", preview.kind === "tool");
      previewText.textContent = preview.text;
      summary.append(previewLabel, previewText);
    } else {
      summary.textContent = session.summary || "No recent output yet.";
    }

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
    if (state.liveRefreshTimer) clearTimeout(state.liveRefreshTimer);
    state.liveRefreshTimer = setTimeout(() => {
      state.liveRefreshTimer = null;
      void refreshNow("event");
    }, LIVE_REFRESH_DEBOUNCE_MS);
    state.liveRefreshTimer.unref?.();
  }

  function handleCurrentChatChanged() {
    state.currentChatJid = getCurrentChatJid();
    render();
  }

  function handleWindowFocus() {
    if (state.open) void refreshNow("focus");
  }

  function handleWindowResize() {
    if (state.resizeTimer) clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      state.resizeTimer = null;
      const nextLayout = resolveDashboardLayout(globalThis.innerWidth);
      if (nextLayout.limit === state.limit && nextLayout.columns === state.columns) return;
      const previousLimit = state.limit;
      state.limit = nextLayout.limit;
      state.columns = nextLayout.columns;
      render();
      if (state.open && nextLayout.limit > previousLimit && state.sessions.length >= previousLimit) {
        void refreshNow("resize");
      }
    }, RESIZE_DEBOUNCE_MS);
    state.resizeTimer.unref?.();
  }

  function handleKeydown(event) {
    if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isEditableTarget(event.target, event.composedPath?.())) return;
    if (event.key === "Escape" && state.open) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      setOpen(false);
      return;
    }
    if (event.key === "`" || event.key === "~") {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      setOpen(!state.open);
    }
  }

  toggle.addEventListener("click", () => setOpen(!state.open));
  refreshButton.addEventListener("click", () => void refreshNow("manual"));
  window.addEventListener("piclaw:current-chat-changed", handleCurrentChatChanged);
  window.addEventListener("popstate", handleCurrentChatChanged);
  window.addEventListener("piclaw-extension-ui", handleLiveEvent);
  window.addEventListener("piclaw-extension-ui:status", handleLiveEvent);
  window.addEventListener("focus", handleWindowFocus);
  window.addEventListener("resize", handleWindowResize);
  document.addEventListener("keydown", handleKeydown, true);
  if (typeof ResizeObserver !== "undefined") {
    state.panelResizeObserver = new ResizeObserver(updatePanelHeight);
    state.panelResizeObserver.observe(panel);
  }

  render();
  updatePanelHeight();
  schedulePolling();
  schedulePreviewPolling();
  scheduleFooterClock();
  if (state.open) void refreshNow("startup");
  return { root, refreshNow, refreshSessionPreviews, destroy: () => { if (state.pollTimer) clearTimeout(state.pollTimer); if (state.previewTimer) clearTimeout(state.previewTimer); if (state.footerClockTimer) clearTimeout(state.footerClockTimer); if (state.liveRefreshTimer) clearTimeout(state.liveRefreshTimer); if (state.resizeTimer) clearTimeout(state.resizeTimer); state.panelResizeObserver?.disconnect?.(); document.removeEventListener("keydown", handleKeydown, true); window.removeEventListener("piclaw:current-chat-changed", handleCurrentChatChanged); window.removeEventListener("popstate", handleCurrentChatChanged); window.removeEventListener("piclaw-extension-ui", handleLiveEvent); window.removeEventListener("piclaw-extension-ui:status", handleLiveEvent); window.removeEventListener("focus", handleWindowFocus); window.removeEventListener("resize", handleWindowResize); root.remove(); } };
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
  ".timeline-quick-actions",
  ".timeline-quick-actions-portal",
  ".timeline-quick-actions-overlay",
  ".timeline-quick-actions-input",
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

function resolveDashboardLayout(width) {
  const viewportWidth = Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : 1280;
  if (viewportWidth <= NARROW_LAYOUT_MAX_WIDTH) return { columns: 2, rows: 2, limit: 4 };
  if (viewportWidth <= MEDIUM_LAYOUT_MAX_WIDTH) return { columns: 3, rows: 2, limit: 6 };
  return { columns: 4, rows: 2, limit: DEFAULT_LIMIT };
}

function reconcileActiveChats(previous, payload) {
  if (!Array.isArray(payload?.chats)) return previous;
  return new Map(payload.chats.filter((chat) => chat?.chat_jid).map((chat) => [chat.chat_jid, chat]));
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

function activeFillPercent(activeCount, limit) {
  return clampNumber(Math.round((Number(activeCount) / Math.max(1, Number(limit) || 1)) * 100), 0, 100);
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

function resolveStatusPreview(status) {
  return resolveStatusPreviewState(status).preview;
}

function reconcileStatusPreviewResults(previews, retainedPreviews, entries) {
  const next = new Map(previews);
  const retained = new Map(retainedPreviews);
  for (const [jid, result] of entries) {
    if (!result?.ok) continue;
    const resolved = resolveStatusPreviewState(result.status, retained.get(jid));
    if (resolved.retained) retained.set(jid, resolved.retained);
    else retained.delete(jid);
    if (resolved.preview) next.set(jid, resolved.preview);
    else next.delete(jid);
  }
  return { previews: next, retained };
}

function resolveStatusPreviewState(status, retainedPreview = null) {
  if (!status || status.status !== "active") return { preview: null, retained: null };
  const turnIdValue = status.data?.turn_id ?? status.data?.turnId;
  const turnId = typeof turnIdValue === "string" ? turnIdValue.trim() : "";
  const retained = turnId && retainedPreview?.turnId === turnId ? retainedPreview : null;
  const live = normalizePreview("draft", status.draft) || normalizePreview("thinking", status.thought);
  const nextRetained = live && turnId ? { ...live, turnId } : retained;
  return {
    preview: live || normalizeToolPreview(status.data) || nextRetained,
    retained: nextRetained,
  };
}

function normalizePreview(kind, value) {
  const text = cleanPreviewText(typeof value === "string" ? value : value?.text);
  if (!text) return null;
  return {
    kind,
    label: kind === "thinking" ? "thinking" : "draft",
    text: truncateText(text, PREVIEW_MAX_LENGTH),
    totalLines: Number.isFinite(Number(value?.totalLines)) ? Number(value.totalLines) : inferLineCount(text),
  };
}

function normalizeToolPreview(value) {
  if (!value || typeof value !== "object") return null;
  const type = typeof value.type === "string" ? value.type.trim() : "";
  if (type !== "tool_call" && type !== "tool_status") return null;

  const statusValue = value.status ?? value.tool_status ?? value.toolStatus;
  const status = normalizeToolPreviewText(typeof statusValue === "string" ? statusValue : "");
  if (type === "tool_status" && /^(done|failed|cancelled|canceled|aborted)$/i.test(status)) return null;

  const title = resolveToolPreviewTitle(value);
  const statusSuffix = status && !/^working(?:\.{3}|…)?$/i.test(status) ? status : "";
  const text = [title, statusSuffix].filter(Boolean).join(" — ");
  if (!text) return null;

  return {
    kind: "tool",
    label: "tool",
    text: truncateText(text, PREVIEW_MAX_LENGTH),
    totalLines: 1,
  };
}

function resolveToolPreviewTitle(value) {
  const title = normalizeToolPreviewText(typeof value?.title === "string" ? value.title : "");
  if (title) return title;

  const toolNameValue = value?.tool_name ?? value?.toolName;
  const toolName = normalizeToolPreviewText(typeof toolNameValue === "string" ? toolNameValue : "");
  if (!toolName) return "";

  const args = extractToolPreviewArgs(value?.tool_args ?? value?.toolArgs);
  if (!args) return toolName;
  const candidates = [
    args.command,
    Array.isArray(args.commands) ? args.commands.filter((item) => typeof item === "string").join(" && ") : "",
    args.path ?? args.filePath ?? args.target,
    Array.isArray(args.paths) ? args.paths.filter((item) => typeof item === "string").join(", ") : "",
    args.fileName ?? args.filename ?? args.file,
    args.url,
    args.query,
  ];
  const detail = candidates
    .map((candidate) => normalizeToolPreviewText(typeof candidate === "string" ? candidate : ""))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)[0];
  return detail ? `${toolName}: ${truncateText(detail, 120)}` : toolName;
}

function normalizeToolPreviewText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n+/g, " ")
    .trim();
}

function extractToolPreviewArgs(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try { return extractToolPreviewArgs(JSON.parse(value)); } catch { return null; }
  }
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const nested = value.arguments ?? value.input ?? value.params ?? value.parameters ?? value.args ?? value.payload;
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested : value;
}

function cleanPreviewText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/```+/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[\t ]+/g, " ")
    .replace(/\n+/g, " ")
    .replace(/[*_~]{1,3}/g, "")
    .trim();
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function inferLineCount(value) {
  const lines = String(value || "").split(/\r?\n/).filter((line) => line.trim()).length;
  return lines || 0;
}

function previewMapsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (!other || other.kind !== value.kind || other.text !== value.text || other.totalLines !== value.totalLines) return false;
  }
  return true;
}

function buildSessionUrl(chatJid, href = globalThis.location?.href || "http://localhost/") {
  const url = new URL(href);
  url.searchParams.set("chat_jid", chatJid);
  url.searchParams.delete("branch_loader");
  url.searchParams.delete("branch_source_chat_jid");
  url.searchParams.delete("pane_popout");
  url.searchParams.delete("pane_path");
  url.searchParams.delete("pane_label");
  return url.toString();
}

function navigateToSession(chatJid, event, runtimeWindow = globalThis.window) {
  const url = buildSessionUrl(chatJid, runtimeWindow?.location?.href);
  if (event?.metaKey || event?.ctrlKey || event?.button === 1) {
    runtimeWindow?.open?.(url, "_blank", "noopener");
    return "new-tab";
  }
  if (typeof runtimeWindow?.history?.pushState === "function" && typeof runtimeWindow?.dispatchEvent === "function") {
    runtimeWindow.history.pushState(null, "", url);
    const NavigationEvent = runtimeWindow.PopStateEvent || globalThis.PopStateEvent || globalThis.Event;
    runtimeWindow.dispatchEvent(new NavigationEvent("popstate", { state: null }));
    return "in-app";
  }
  if (runtimeWindow?.location) runtimeWindow.location.href = url;
  return "reload";
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

function formatRelativeTime(value, now = Date.now()) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "never";
  const delta = Math.max(0, now - time);
  if (delta < 1_000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
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
      --session-dashboard-active-fill: 0%;
    }
    .session-dashboard-toggle {
      pointer-events: auto;
      position: fixed;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      z-index: 120;
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      width: 34px;
      min-height: 28px;
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
    .session-dashboard-toggle svg { width: 12px; height: 12px; flex-shrink: 0; order: 2; transition: transform var(--ui-transition-fast, .18s); }
    .session-dashboard-root.open .session-dashboard-toggle svg { transform: rotate(180deg); }
    .session-dashboard-toggle-dot {
      position: relative;
      width: 14px;
      height: 3px;
      border-radius: 999px;
      overflow: hidden;
      order: 1;
      background: color-mix(in srgb, var(--border-color, rgba(148,163,184,.45)) 72%, transparent);
    }
    .session-dashboard-toggle-dot::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: var(--session-dashboard-active-fill, 0%);
      border-radius: inherit;
      background: var(--accent-color,#2563eb);
      transition: width var(--ui-transition-fast, .18s);
    }
    .session-dashboard-root.loading .session-dashboard-toggle-dot::before { opacity: .72; }
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
    .session-dashboard-refresh {
      border: 1px solid var(--border-color, rgba(148,163,184,.28));
      border-radius: 6px;
      padding: 3px 8px;
      background: var(--bg-secondary,#111827);
      color: var(--text-secondary,#94a3b8);
      cursor: pointer;
      font-size: 10px;
    }
    .session-dashboard-refresh:hover { color: var(--text-primary,#e5e7eb); border-color: var(--accent-color,#2563eb); }
    .session-dashboard-refresh:disabled { opacity: .45; cursor: default; }
    .session-dashboard-grid {
      display: grid;
      grid-template-columns: repeat(var(--session-dashboard-columns, 4), minmax(0, 1fr));
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
    .session-dashboard-preview-label { display: inline-flex; align-items: center; max-width: max-content; margin: 0 6px 2px 0; padding: 1px 5px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--accent-color,#2563eb) 38%, transparent); color: var(--accent-color,#60a5fa); font-size: 9px; line-height: 1.3; text-transform: uppercase; letter-spacing: .04em; }
    .session-dashboard-preview-text.tool { font-family: var(--font-mono, var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace)); font-size: .92em; overflow-wrap: anywhere; }
    .session-dashboard-context { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--text-secondary,#94a3b8); font-size: 10px; }
    .session-dashboard-context-meter { flex: 1; height: 5px; max-width: 90px; border-radius: 999px; background: color-mix(in srgb, var(--border-color, rgba(148,163,184,.35)) 72%, transparent); overflow: hidden; }
    .session-dashboard-context-meter span { display: block; height: 100%; border-radius: inherit; background: var(--accent-color,#2563eb); }
    .session-dashboard-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; max-width: var(--session-dashboard-max-width); margin: 10px auto 0; min-height: 22px; color: var(--text-secondary,#94a3b8); font-size: 10px; }
    .session-dashboard-footer-status { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-dashboard-empty { grid-column: 1 / -1; border: 1px dashed var(--border-color, rgba(148,163,184,.35)); border-radius: var(--radius-md, 8px); padding: 18px; text-align: center; color: var(--text-secondary,#94a3b8); }
    @media (max-width: 720px) { .session-dashboard-panel { max-height: 72vh; } .session-dashboard-tile { padding: 8px; } .session-dashboard-footer-status { white-space: normal; } }
  `;
  document.head.appendChild(style);
}

export const __sessionDashboardTest = {
  mergeSessions,
  reconcileActiveChats,
  reconcileStatusPreviewResults,
  resolveDashboardLayout,
  activeFillPercent,
  isEditableTarget,
  normalizeContext,
  formatContext,
  normalizePreview,
  normalizeToolPreview,
  resolveStatusPreview,
  resolveStatusPreviewState,
  previewMapsEqual,
  buildSessionUrl,
  navigateToSession,
  formatRelativeTime,
  agentNameFromChatJid,
};
