// @ts-nocheck
const ADDON_ID = "yolo-vibe";
const STYLE_ID = "piclaw-yolo-vibe-style";
const TOOLBAR_CLASS = "piclaw-yolo-vibe-toolbar";
const HOST_CLASS = "piclaw-yolo-vibe-host";
const DEFAULT_CHAT_JID = "web:default";

export const YOLO_VIBE_BUTTONS = [
  { id: "continue", label: "Continue", prompt: "continue" },
  { id: "audit", label: "Audit", prompt: "audit for code smells and logic errors, fixing as you go" },
  { id: "docs", label: "Docs", prompt: "review and update all documentation, then commit and push" },
];

export function normalizeChatJid(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || DEFAULT_CHAT_JID;
}

export function getCurrentChatJid() {
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

export function buildAgentMessageRequest(prompt, chatJid = getCurrentChatJid()) {
  return {
    url: `/agent/default/message?chat_jid=${encodeURIComponent(normalizeChatJid(chatJid))}`,
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: String(prompt || ""), mode: "auto", media_ids: [] }),
    },
  };
}

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${HOST_CLASS}{position:relative}
.${TOOLBAR_CLASS}{position:fixed;display:inline-flex;align-items:center;justify-content:flex-end;gap:4px;margin:0;z-index:12;pointer-events:auto;white-space:nowrap}
.${TOOLBAR_CLASS} button{appearance:none;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-secondary);border-radius:var(--radius-full,999px);padding:3px 8px;font-size:11px;font-weight:700;line-height:1.25;cursor:pointer;transition:background-color var(--ui-transition-fast,.12s),color var(--ui-transition-fast,.12s),border-color var(--ui-transition-fast,.12s),opacity var(--ui-transition-fast,.12s)}
.${TOOLBAR_CLASS} button:hover,.${TOOLBAR_CLASS} button:focus-visible{background:var(--bg-hover);color:var(--text-primary);border-color:var(--accent-color);outline:none}
.${TOOLBAR_CLASS} button:disabled{opacity:.58;cursor:progress}
.${TOOLBAR_CLASS}[data-busy="true"] button:not([data-sending="true"]){opacity:.45}
@media (max-width: 640px){.${TOOLBAR_CLASS}{gap:3px}.${TOOLBAR_CLASS} button{font-size:10.5px;padding:3px 6px}}
`;
  document.head.appendChild(style);
}

async function submitPrompt(prompt, button, toolbar) {
  const text = String(prompt || "").trim();
  if (!text) return;
  toolbar.dataset.busy = "true";
  button.dataset.sending = "true";
  button.disabled = true;
  const previousTitle = button.title || "";
  button.title = "Sending…";
  try {
    const request = buildAgentMessageRequest(text, getCurrentChatJid());
    const response = await fetch(request.url, request.options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    button.title = payload?.queued ? "Queued." : "Sent.";
    setTimeout(() => { button.title = previousTitle; }, 1400);
  } catch (error) {
    console.error(`[${ADDON_ID}] Failed to submit quick prompt`, error);
    button.title = error?.message || "Failed to send.";
    setTimeout(() => { button.title = previousTitle; }, 2500);
  } finally {
    button.disabled = false;
    delete button.dataset.sending;
    toolbar.dataset.busy = "false";
  }
}

export function findComposeInsertionPoint(root = typeof document !== "undefined" ? document : null) {
  const wrapper = root?.querySelector?.(".compose-input-wrapper");
  if (!wrapper) return null;
  const sessionGroup = wrapper.querySelector?.(".compose-session-trigger-group.compose-session-trigger-top");
  if (!sessionGroup) return null;
  const composeBox = wrapper.closest?.(".compose-box") || wrapper.parentElement;
  if (!composeBox) return null;
  return { composeBox, wrapper, sessionGroup };
}

function buildToolbar() {
  const toolbar = document.createElement("div");
  toolbar.className = TOOLBAR_CLASS;
  toolbar.dataset.addon = ADDON_ID;
  toolbar.setAttribute("role", "group");
  toolbar.setAttribute("aria-label", "YOLO vibe quick prompts");
  for (const action of YOLO_VIBE_BUTTONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action.id;
    button.textContent = action.label;
    button.title = action.prompt;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void submitPrompt(action.prompt, button, toolbar);
    });
    toolbar.appendChild(button);
  }
  return toolbar;
}

function positionToolbar(point, toolbar) {
  const win = toolbar.ownerDocument?.defaultView || globalThis;
  const wrapperRect = point.wrapper.getBoundingClientRect?.();
  const composeRect = point.composeBox.getBoundingClientRect?.();
  const toolbarRect = toolbar.getBoundingClientRect?.();
  if (!wrapperRect || !composeRect || !toolbarRect) return;
  const viewportWidth = win.innerWidth || toolbar.ownerDocument?.documentElement?.clientWidth || wrapperRect.right;
  const toolbarWidth = Math.ceil(toolbarRect.width || 0);
  const toolbarHeight = Math.ceil(toolbarRect.height || 0);
  const left = Math.max(8, Math.min(Math.round(wrapperRect.right - toolbarWidth), viewportWidth - toolbarWidth - 8));
  const top = Math.max(8, Math.round(composeRect.top - toolbarHeight - 6));
  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
  toolbar.style.right = "auto";
  toolbar.style.bottom = "auto";
}

export function installYoloVibe(root = typeof document !== "undefined" ? document : null) {
  if (typeof document === "undefined" || !root) return false;
  ensureStyles();
  const point = findComposeInsertionPoint(root);
  if (!point) return false;
  const owner = point.wrapper.ownerDocument || document;
  const target = owner.body || owner.documentElement;
  const existing = owner.querySelector(`.${TOOLBAR_CLASS}[data-addon="${ADDON_ID}"]`) || point.composeBox.querySelector(`.${TOOLBAR_CLASS}`) || point.sessionGroup.querySelector(`.${TOOLBAR_CLASS}`);
  const toolbar = existing || buildToolbar();
  point.sessionGroup.classList.remove(HOST_CLASS);
  point.composeBox.classList.remove(HOST_CLASS);
  if (toolbar.parentElement !== target) target.appendChild(toolbar);
  positionToolbar(point, toolbar);
  try { requestAnimationFrame?.(() => positionToolbar(point, toolbar)); } catch {}
  return true;
}

function scheduleInstall() {
  const attempt = () => { try { installYoloVibe(); } catch (error) { console.warn(`[${ADDON_ID}] install failed`, error); } };
  attempt();
  try { queueMicrotask(attempt); } catch {}
  try { requestAnimationFrame?.(attempt); } catch {}
  try { setTimeout(attempt, 0); } catch {}
  try { setTimeout(attempt, 250); } catch {}
  try { setTimeout(attempt, 1000); } catch {}
  if (typeof window !== "undefined") {
    try { window.addEventListener("resize", attempt, { passive: true }); } catch {}
    try { window.addEventListener("scroll", attempt, { passive: true, capture: true }); } catch {}
  }
  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    const observer = new MutationObserver(() => attempt());
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
}

try {
  scheduleInstall();
} catch {}
