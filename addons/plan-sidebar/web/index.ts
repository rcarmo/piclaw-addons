// @ts-nocheck
const ADDON_ID = "plan-sidebar";
const API = `/agent/addons/api/${ADDON_ID}/plan`;
const STORAGE_OPEN = "piclaw:plan-sidebar:open";
const STORAGE_WIDTH = "piclaw:plan-sidebar:width";
const DEFAULT_CHAT_JID = "web:default";

if (!globalThis.__piclawPlanSidebarInstalled) {
  globalThis.__piclawPlanSidebarInstalled = true;
  installPlanSidebar();
}

function installPlanSidebar() {
  if (typeof document === "undefined") return;

  const state = {
    open: localStorage.getItem(STORAGE_OPEN) === "true",
    width: clampWidth(Number(localStorage.getItem(STORAGE_WIDTH)) || 380),
    chatJid: getCurrentChatJid(),
    markdown: "",
    updatedAt: null,
    dirty: false,
    loading: false,
    editorView: null,
    cm: null,
    editorThemeCompartment: null,
    themeObserver: null,
    fallbackTextarea: null,
    resizeStart: null,
  };

  injectStyles();

  const root = document.createElement("div");
  root.className = "plan-sidebar-root";
  root.innerHTML = `
    <button class="plan-sidebar-toggle" type="button" aria-label="Show plan" title="Show plan">
      <span class="plan-sidebar-toggle-meter" aria-hidden="true"><span class="plan-sidebar-toggle-meter-fill"></span></span>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="10 3 5 8 10 13" /></svg>
      <span class="plan-sidebar-toggle-progress plan-sidebar-sr-only"></span>
    </button>
    <aside class="plan-sidebar-panel" aria-label="Session plan">
      <div class="plan-sidebar-resizer" title="Resize plan sidebar"></div>
      <header class="plan-sidebar-header">
        <div class="plan-sidebar-title">Plan</div>
        <div class="plan-sidebar-subtitle"></div>
      </header>
      <div class="plan-sidebar-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="plan-sidebar-progress-meta">
          <span class="plan-sidebar-progress-label">No checklist items</span>
          <span class="plan-sidebar-progress-percent">0%</span>
        </div>
        <div class="plan-sidebar-progress-track"><div class="plan-sidebar-progress-fill"></div></div>
      </div>
      <div class="plan-sidebar-editor" role="region" aria-label="Markdown checklist editor"></div>
      <footer class="plan-sidebar-footer">
        <div class="plan-sidebar-status" aria-live="polite"></div>
        <div class="plan-sidebar-actions">
          <button class="plan-sidebar-refresh" type="button">Refresh</button>
          <button class="plan-sidebar-save" type="button">Save</button>
          <button class="plan-sidebar-submit" type="button">Submit to model</button>
        </div>
      </footer>
    </aside>
  `;
  document.body.appendChild(root);

  const toggle = root.querySelector(".plan-sidebar-toggle");
  const panel = root.querySelector(".plan-sidebar-panel");
  const subtitle = root.querySelector(".plan-sidebar-subtitle");
  const progress = root.querySelector(".plan-sidebar-progress");
  const progressLabel = root.querySelector(".plan-sidebar-progress-label");
  const progressPercent = root.querySelector(".plan-sidebar-progress-percent");
  const progressFill = root.querySelector(".plan-sidebar-progress-fill");
  const toggleMeterFill = root.querySelector(".plan-sidebar-toggle-meter-fill");
  const toggleProgress = root.querySelector(".plan-sidebar-toggle-progress");
  const editorHost = root.querySelector(".plan-sidebar-editor");
  const status = root.querySelector(".plan-sidebar-status");
  const refreshButton = root.querySelector(".plan-sidebar-refresh");
  const saveButton = root.querySelector(".plan-sidebar-save");
  const submitButton = root.querySelector(".plan-sidebar-submit");
  const resizer = root.querySelector(".plan-sidebar-resizer");

  function renderChrome() {
    const currentMarkdown = state.editorView ? state.editorView.state.doc.toString() : state.fallbackTextarea?.value || state.markdown || "";
    const currentProgress = getPlanProgress(currentMarkdown);
    root.classList.toggle("open", state.open);
    root.classList.toggle("has-checklist", currentProgress.total > 0);
    root.style.setProperty("--plan-sidebar-width", `${state.width}px`);
    panel.style.width = `${state.width}px`;
    toggle.title = state.open ? "Hide plan" : `Show plan • ${formatProgressText(currentProgress)}`;
    toggle.setAttribute("aria-label", state.open ? "Hide plan" : `Show plan. ${formatProgressText(currentProgress)}.`);
    toggle.classList.toggle("open", state.open);
    subtitle.textContent = `${state.chatJid}${state.dirty ? " • unsaved" : ""}`;
    renderProgress(currentProgress);
    saveButton.disabled = state.loading || !state.dirty;
    submitButton.disabled = state.loading;
    refreshButton.disabled = state.loading;
  }

  function renderProgress(planProgress) {
    const text = formatProgressText(planProgress);
    progress.setAttribute("aria-valuenow", String(planProgress.percent));
    progress.setAttribute("aria-valuetext", text);
    progressLabel.textContent = planProgress.total ? `${planProgress.complete}/${planProgress.total} items complete` : "No checklist items";
    progressPercent.textContent = `${planProgress.percent}%`;
    progressFill.style.width = `${planProgress.percent}%`;
    toggleMeterFill.style.height = `${planProgress.percent}%`;
    toggleProgress.textContent = text;
  }

  function setStatus(message, kind = "info") {
    status.textContent = message || "";
    status.dataset.kind = kind;
  }

  function setOpen(next) {
    state.open = Boolean(next);
    localStorage.setItem(STORAGE_OPEN, state.open ? "true" : "false");
    renderChrome();
    if (state.open) {
      ensureEditor().then(() => loadPlan({ preserveDirty: true })).catch((error) => setStatus(String(error?.message || error), "error"));
      setTimeout(() => focusEditor(), 80);
    }
  }

  function getEditorValue() {
    if (state.editorView) return state.editorView.state.doc.toString();
    return state.fallbackTextarea?.value || state.markdown || "";
  }

  function setEditorValue(value) {
    const next = String(value || "");
    state.markdown = next;
    if (state.editorView) {
      const current = state.editorView.state.doc.toString();
      if (current !== next) {
        state.editorView.dispatch({ changes: { from: 0, to: current.length, insert: next } });
      }
    } else if (state.fallbackTextarea && state.fallbackTextarea.value !== next) {
      state.fallbackTextarea.value = next;
    }
  }

  function markDirty(next = true) {
    state.dirty = Boolean(next);
    renderChrome();
  }

  async function ensureEditor() {
    if (state.editorView || state.fallbackTextarea) return;
    try {
      const cm = await import("/editor-vendor/codemirror.js");
      state.cm = cm;
      state.editorThemeCompartment = new cm.Compartment();
      const extensions = [
        cm.minimalSetup,
        cm.markdown(),
        cm.EditorView.lineWrapping,
        state.editorThemeCompartment.of(buildEditorThemeExtensions(cm)),
        cm.EditorView.updateListener.of((update) => {
          if (update.docChanged) markDirty(true);
        }),
      ];
      state.editorView = new cm.EditorView({
        state: cm.EditorState.create({ doc: state.markdown || "", extensions }),
        parent: editorHost,
      });
      ensureThemeObserver();
    } catch (error) {
      console.warn("[plan-sidebar] CodeMirror unavailable, falling back to textarea", error);
      const textarea = document.createElement("textarea");
      textarea.className = "plan-sidebar-textarea";
      textarea.spellcheck = false;
      textarea.value = state.markdown || "";
      textarea.addEventListener("input", () => markDirty(true));
      editorHost.appendChild(textarea);
      state.fallbackTextarea = textarea;
    }
  }

  function focusEditor() {
    if (state.editorView) state.editorView.focus();
    else state.fallbackTextarea?.focus();
  }

  function buildEditorThemeExtensions(cm) {
    const mode = getThemeMode();
    const accent = readCssVar("--accent-color", "#1d9bf0");
    const rgb = colorToRgb(accent) || "29, 155, 240";
    const baseTheme = (mode === "light" ? cm.githubLight : cm.githubDark) || [];
    return [
      baseTheme,
      cm.EditorView.theme({
        "&": {
          height: "100%",
          background: "var(--bg-primary,#0b1020)",
          color: "var(--text-primary,#e5e7eb)",
          fontSize: "13px",
        },
        ".cm-scroller": {
          fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
          lineHeight: "1.45",
          background: "var(--bg-primary,#0b1020)",
        },
        ".cm-content": {
          padding: "12px",
          caretColor: accent,
        },
        ".cm-gutters": { display: "none" },
        ".cm-line": { color: "var(--text-primary,#e5e7eb)" },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: accent,
          borderLeftWidth: "2px",
        },
        "&.cm-focused .cm-cursor": {
          borderLeftColor: accent,
          borderLeftWidth: "2px",
        },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          backgroundColor: `rgba(${rgb}, 0.22) !important`,
        },
        ".cm-activeLine": { backgroundColor: `rgba(${rgb}, 0.07)` },
        ".cm-selectionMatch": { backgroundColor: `rgba(${rgb}, 0.16)` },
        ".cm-focused": { outline: "none" },
      }),
    ];
  }

  function applyEditorTheme() {
    if (!state.editorView || !state.cm || !state.editorThemeCompartment) return;
    state.editorView.dispatch({
      effects: state.editorThemeCompartment.reconfigure(buildEditorThemeExtensions(state.cm)),
    });
  }

  function ensureThemeObserver() {
    if (state.themeObserver || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => applyEditorTheme());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-color-theme", "style"] });
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme"] });
    state.themeObserver = observer;
  }

  async function apiJson(url, options) {
    const response = await fetch(url, { credentials: "same-origin", ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `${response.status} ${response.statusText}`);
    return payload;
  }

  function planUrl() {
    return `${API}?chat_jid=${encodeURIComponent(state.chatJid)}`;
  }

  async function loadPlan({ preserveDirty = false } = {}) {
    if (state.loading) return;
    if (preserveDirty && state.dirty) return;
    state.loading = true;
    renderChrome();
    try {
      const plan = await apiJson(planUrl());
      state.updatedAt = plan.updated_at || null;
      setEditorValue(plan.markdown || "");
      markDirty(false);
      setStatus(state.updatedAt ? `Loaded ${formatTime(state.updatedAt)}` : "Loaded default plan");
    } catch (error) {
      setStatus(String(error?.message || error), "error");
    } finally {
      state.loading = false;
      renderChrome();
    }
  }

  async function savePlan() {
    state.loading = true;
    renderChrome();
    try {
      const payload = await apiJson(planUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_jid: state.chatJid, markdown: getEditorValue() }),
      });
      const plan = payload.plan || payload;
      state.updatedAt = plan.updated_at || null;
      state.markdown = plan.markdown || getEditorValue();
      markDirty(false);
      setStatus(`Saved ${formatTime(state.updatedAt)}`, "ok");
      return plan;
    } catch (error) {
      setStatus(String(error?.message || error), "error");
      throw error;
    } finally {
      state.loading = false;
      renderChrome();
    }
  }

  function buildPlanSubmissionPrompt(markdown) {
    return [
      "The text below is the current Plan sidebar checklist for this session.",
      "It is editable shared state, not a static user note: you can modify it and must keep it current as work proceeds.",
      "Use the `plan` tool with `action=read` to inspect it, `action=edit` with exact oldText/newText blocks for atomic item updates, and `action=write` only when replacing the whole checklist.",
      "Treat checked items as completed, unchecked items as pending, and save a revised checklist after meaningful progress or plan changes.",
      "",
      "```markdown",
      markdown,
      "```",
    ].join("\n");
  }

  async function submitToModel() {
    const plan = await savePlan();
    const markdown = plan.markdown || "";
    if (!markdown.trim()) {
      setStatus("Plan is empty; nothing to submit.", "error");
      return;
    }
    state.loading = true;
    renderChrome();
    try {
      const content = buildPlanSubmissionPrompt(markdown);
      await apiJson(`/agent/default/message?chat_jid=${encodeURIComponent(state.chatJid)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, mode: "auto" }),
      });
      setStatus("Submitted to model.", "ok");
    } catch (error) {
      setStatus(String(error?.message || error), "error");
    } finally {
      state.loading = false;
      renderChrome();
    }
  }

  function updateChatJid() {
    const next = getCurrentChatJid();
    if (next === state.chatJid) return;
    state.chatJid = next;
    state.dirty = false;
    renderChrome();
    if (state.open) loadPlan();
  }

  toggle.addEventListener("click", () => setOpen(!state.open));
  refreshButton.addEventListener("click", () => loadPlan());
  saveButton.addEventListener("click", () => savePlan().catch(() => undefined));
  submitButton.addEventListener("click", () => submitToModel().catch(() => undefined));

  resizer.addEventListener("mousedown", (event) => {
    event.preventDefault();
    state.resizeStart = { x: event.clientX, width: state.width };
    document.body.classList.add("plan-sidebar-resizing");
  });
  window.addEventListener("mousemove", (event) => {
    if (!state.resizeStart) return;
    state.width = clampWidth(state.resizeStart.width + (state.resizeStart.x - event.clientX));
    localStorage.setItem(STORAGE_WIDTH, String(state.width));
    renderChrome();
  });
  window.addEventListener("mouseup", () => {
    state.resizeStart = null;
    document.body.classList.remove("plan-sidebar-resizing");
  });

  window.addEventListener("piclaw:current-chat-changed", updateChatJid);
  window.addEventListener("popstate", updateChatJid);

  renderChrome();
  if (state.open) setOpen(true);
}

function getPlanProgress(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  let total = 0;
  let complete = 0;
  for (const line of lines) {
    const match = line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX-])\](?:\s|$)/);
    if (!match) continue;
    total += 1;
    if (match[1].toLowerCase() === "x") complete += 1;
  }
  return {
    total,
    complete,
    percent: total ? Math.round((complete / total) * 100) : 0,
  };
}

function formatProgressText(progress) {
  if (!progress?.total) return "No checklist items";
  return `${progress.complete}/${progress.total} items complete (${progress.percent}%)`;
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

function clampWidth(value) {
  return Math.max(300, Math.min(620, Math.trunc(value || 380)));
}

function formatTime(value) {
  if (!value) return "";
  try { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return String(value); }
}

function getThemeMode() {
  const root = document.documentElement;
  const body = document.body;
  const explicit = root?.getAttribute?.("data-theme")?.toLowerCase?.() || body?.getAttribute?.("data-theme")?.toLowerCase?.() || "";
  if (explicit === "light" || explicit === "dark") return explicit;
  if (root?.classList?.contains("light") || body?.classList?.contains("light")) return "light";
  if (root?.classList?.contains("dark") || body?.classList?.contains("dark")) return "dark";
  return globalThis.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
}

function readCssVar(name, fallback) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
}

function colorToRgb(value) {
  const text = String(value || "").trim();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? hex.split("").map((ch) => ch + ch).join("") : hex;
    return `${parseInt(full.slice(0, 2), 16)}, ${parseInt(full.slice(2, 4), 16)}, ${parseInt(full.slice(4, 6), 16)}`;
  }
  const rgb = text.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  return rgb ? `${rgb[1]}, ${rgb[2]}, ${rgb[3]}` : null;
}

function injectStyles() {
  if (document.getElementById("plan-sidebar-styles")) return;
  const style = document.createElement("style");
  style.id = "plan-sidebar-styles";
  style.textContent = `
    .plan-sidebar-toggle {
      display: flex;
      position: fixed;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      z-index: 120;
      background: var(--bg-secondary,#111827);
      border: 1px solid var(--border-color, rgba(148,163,184,.35));
      border-right: 0;
      color: var(--text-secondary,#cbd5e1);
      padding: 0;
      width: var(--workspace-tab-width, 20px);
      height: 52px;
      border-radius: var(--radius-md, 8px) 0 0 var(--radius-md, 8px);
      box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,.18));
      cursor: pointer;
      align-items: center;
      justify-content: center;
      transition: right var(--ui-transition-fast, .18s), background-color var(--ui-transition-fast, .18s), color var(--ui-transition-fast, .18s), border-color var(--ui-transition-fast, .18s), box-shadow var(--ui-transition-fast, .18s);
    }
    .plan-sidebar-toggle:hover { color: var(--text-primary,#f8fafc); border-color: var(--accent-color,#2563eb); }
    .plan-sidebar-toggle svg { width: 12px; height: 12px; flex-shrink: 0; transition: transform var(--ui-transition-fast, .18s); }
    .plan-sidebar-toggle-meter {
      position: absolute;
      left: 3px;
      top: 8px;
      bottom: 8px;
      width: 3px;
      border-radius: 999px;
      overflow: hidden;
      background: color-mix(in srgb, var(--border-color, rgba(148,163,184,.45)) 72%, transparent);
      opacity: .95;
    }
    .plan-sidebar-toggle-meter-fill {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 0%;
      border-radius: 999px;
      background: var(--accent-color,#2563eb);
      transition: height var(--ui-transition-fast, .18s);
    }
    .plan-sidebar-root:not(.has-checklist) .plan-sidebar-toggle-meter { opacity: .35; }
    .plan-sidebar-root.open .plan-sidebar-toggle-meter { display: none; }
    .plan-sidebar-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .plan-sidebar-root.open .plan-sidebar-toggle { right: calc(var(--plan-sidebar-width, 380px) - var(--workspace-tab-width, 20px)); }
    .plan-sidebar-root.open .plan-sidebar-toggle svg { transform: rotate(180deg); }
    .plan-sidebar-panel {
      --plan-sidebar-width: 380px;
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 119;
      width: 380px;
      transform: translateX(100%);
      transition: transform .18s ease;
      background: var(--bg-primary,#0b1020);
      border-left: 1px solid var(--border-color, rgba(148,163,184,.28));
      box-shadow: -18px 0 42px rgba(0,0,0,.28);
      display: flex;
      flex-direction: column;
      color: var(--text-primary,#e5e7eb);
    }
    .plan-sidebar-root.open .plan-sidebar-panel { transform: translateX(0); }
    .plan-sidebar-header {
      min-height: 34px;
      padding: 5px 10px;
      border-bottom: 1px solid var(--border-color, rgba(148,163,184,.25));
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .plan-sidebar-title { flex: 0 0 auto; font-weight: 650; font-size: 12px; letter-spacing: .01em; }
    .plan-sidebar-subtitle { color: var(--text-secondary,#94a3b8); font-size: 10px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .plan-sidebar-progress {
      border-bottom: 1px solid var(--border-color, rgba(148,163,184,.2));
      padding: 8px 10px 9px;
      background: var(--bg-secondary,#111827);
      display: grid;
      gap: 6px;
    }
    .plan-sidebar-progress-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--text-secondary,#94a3b8);
      font-size: 10px;
      line-height: 1.2;
    }
    .plan-sidebar-progress-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .plan-sidebar-progress-percent { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--text-primary,#e5e7eb); }
    .plan-sidebar-progress-track {
      height: 6px;
      border-radius: 999px;
      overflow: hidden;
      background: color-mix(in srgb, var(--border-color, rgba(148,163,184,.35)) 72%, transparent);
    }
    .plan-sidebar-progress-fill {
      width: 0%;
      height: 100%;
      border-radius: inherit;
      background: var(--accent-color,#2563eb);
      transition: width var(--ui-transition-fast, .18s);
    }
    .plan-sidebar-editor { flex: 1; min-height: 0; overflow: hidden; }
    .plan-sidebar-textarea {
      width: 100%;
      height: 100%;
      border: 0;
      resize: none;
      outline: none;
      padding: 12px;
      box-sizing: border-box;
      background: var(--bg-primary,#0b1020);
      color: var(--text-primary,#e5e7eb);
      caret-color: var(--accent-color,#1d9bf0);
      font: 13px/1.45 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    }
    .plan-sidebar-footer {
      border-top: 1px solid var(--border-color, rgba(148,163,184,.25));
      padding: 10px 12px;
      display: grid;
      gap: 8px;
      background: var(--bg-secondary,#111827);
    }
    .plan-sidebar-status { min-height: 16px; color: var(--text-secondary,#94a3b8); font-size: 11px; }
    .plan-sidebar-status[data-kind="ok"] { color: var(--accent-color,#60a5fa); }
    .plan-sidebar-status[data-kind="error"] { color: var(--danger-color,#f87171); }
    .plan-sidebar-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    .plan-sidebar-actions button {
      border: 1px solid var(--border-color, rgba(148,163,184,.28));
      border-radius: 8px;
      padding: 6px 10px;
      background: var(--bg-primary,#0b1020);
      color: var(--text-primary,#e5e7eb);
      cursor: pointer;
      font-size: 12px;
    }
    .plan-sidebar-actions button:disabled { opacity: .45; cursor: default; }
    .plan-sidebar-submit { background: var(--accent-color,#2563eb) !important; border-color: var(--accent-color,#2563eb) !important; color: white !important; }
    .plan-sidebar-resizer { position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; cursor: ew-resize; }
    .plan-sidebar-resizing, .plan-sidebar-resizing * { cursor: ew-resize !important; user-select: none !important; }
    @media (max-width: 760px) {
      .plan-sidebar-panel { width: min(92vw, 420px) !important; }
      .plan-sidebar-root.open .plan-sidebar-toggle { right: calc(min(92vw, 420px) - var(--workspace-tab-width, 20px)); }
    }
  `;
  document.head.appendChild(style);
}
