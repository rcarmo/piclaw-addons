// @ts-nocheck
const ADDON_ID = "yolo-vibe";
const STYLE_ID = "piclaw-yolo-vibe-style";
const TOOLBAR_CLASS = "piclaw-yolo-vibe-toolbar";
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
.${TOOLBAR_CLASS}{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin:30px 0 2px auto;max-width:100%;z-index:4;pointer-events:auto}
.${TOOLBAR_CLASS} button{appearance:none;border:1px solid color-mix(in srgb,var(--accent-color,#3b82f6) 34%,var(--border-color,rgba(148,163,184,.24)));background:color-mix(in srgb,var(--bg-secondary,#111827) 82%,var(--accent-color,#3b82f6) 18%);color:var(--text-primary,#e5e7eb);border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700;line-height:1.25;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.12);transition:transform .12s ease,background .12s ease,border-color .12s ease,opacity .12s ease}
.${TOOLBAR_CLASS} button:hover,.${TOOLBAR_CLASS} button:focus-visible{transform:translateY(-1px);background:color-mix(in srgb,var(--bg-secondary,#111827) 70%,var(--accent-color,#3b82f6) 30%);border-color:var(--accent-color,#3b82f6);outline:none}
.${TOOLBAR_CLASS} button:disabled{opacity:.58;cursor:progress;transform:none}
.${TOOLBAR_CLASS}[data-busy="true"] button:not([data-sending="true"]){opacity:.45}
@media (max-width: 640px){.${TOOLBAR_CLASS}{gap:3px;margin-top:31px}.${TOOLBAR_CLASS} button{font-size:10.5px;padding:3px 6px}}
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

export function findComposeInsertionPoint(root = document) {
  const wrapper = root.querySelector?.(".compose-input-wrapper");
  if (!wrapper) return null;
  const sessionGroup = wrapper.querySelector?.(".compose-session-trigger-group.compose-session-trigger-top");
  const inputMain = wrapper.querySelector?.(".compose-input-main");
  if (!inputMain) return null;
  return { wrapper, sessionGroup, inputMain };
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

export function installYoloVibe(root = document) {
  if (typeof document === "undefined") return false;
  ensureStyles();
  const point = findComposeInsertionPoint(root);
  if (!point) return false;
  if (point.wrapper.querySelector(`.${TOOLBAR_CLASS}`)) return true;
  const toolbar = buildToolbar();
  point.wrapper.insertBefore(toolbar, point.inputMain);
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
  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    const observer = new MutationObserver(() => attempt());
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
}

try {
  scheduleInstall();
} catch {}
