// @ts-nocheck
const ADDON_ID = "goal";
const API = `/agent/addons/api/${ADDON_ID}`;
const DEFAULT_CHAT_JID = "web:default";
const SESSION_UPDATED_KEY = "goal.session-updated";
const STATUS_KEY = "goal";
const PROGRESS_STORAGE_PREFIX = "piclaw:goal-progress:";
const VISIBLE_REFRESH_MS = 15000;
const FAILURE_BACKOFF_BASE_MS = 5000;
const FAILURE_BACKOFF_MAX_MS = 60000;
const CIRCUIT_BREAKER_AFTER_FAILURES = 3;
const CIRCUIT_BREAKER_MS = 120000;

const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
const html = preactHtm?.html;
const useState = preactHtm?.useState;
const useEffect = preactHtm?.useEffect;
const useCallback = preactHtm?.useCallback;
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

const ICON = HAS_RUNTIME
  ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle><path d="M12 2v3"></path><path d="M12 19v3"></path><path d="M2 12h3"></path><path d="M19 12h3"></path></svg>`
  : null;

function normalizeChatJid(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || DEFAULT_CHAT_JID;
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

function withChat(url, chatJid) {
  const actual = normalizeChatJid(chatJid);
  return `${url}${url.includes("?") ? "&" : "?"}chat_jid=${encodeURIComponent(actual)}`;
}

function progressStorageKey(chatJid) {
  return `${PROGRESS_STORAGE_PREFIX}${normalizeChatJid(chatJid)}`;
}

function readCachedProgressSession(chatJid) {
  try {
    const raw = localStorage.getItem(progressStorageKey(chatJid));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function persistCachedProgressSession(session) {
  const chatJid = normalizeChatJid(session?.chat_jid);
  if (!chatJid) return;
  try { localStorage.setItem(progressStorageKey(chatJid), JSON.stringify(session)); } catch {}
}

async function apiJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

async function loadConfig() {
  return await apiJson(`${API}/config`);
}

async function saveConfig(patch) {
  return await apiJson(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

async function loadSession(chatJid) {
  return await apiJson(withChat(`${API}/session`, chatJid));
}

async function saveSession(chatJid, patch) {
  return await apiJson(withChat(`${API}/session`, chatJid), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...patch, chat_jid: normalizeChatJid(chatJid) }),
  });
}

function positiveNumber(value, fallback = 1) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function formatTokenCount(value) {
  const numeric = Math.max(0, Math.trunc(Number(value) || 0));
  if (numeric < 1000) return String(numeric);
  const units = ["k", "m", "b", "t"];
  let scaled = numeric;
  let unit = units[0];
  for (let i = 0; i < units.length; i += 1) {
    scaled = numeric / (1000 ** (i + 1));
    unit = units[i];
    if (scaled < 1000 || i === units.length - 1) break;
  }
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(decimals).replace(/\.0+$|(?<=\.\d)0+$/g, "")}${unit}`;
}

const BRAILLE_TOKEN_BAR_LEVELS = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"];

function renderTokenAvailabilityBar(tokensUsedInput, tokenBudgetInput, width = 8) {
  const tokenBudget = Math.max(0, positiveNumber(tokenBudgetInput, 0));
  const tokensUsed = Math.max(0, positiveNumber(tokensUsedInput, 0));
  const safeWidth = Math.max(1, Math.min(32, Math.trunc(width || 8)));
  const maxLevel = BRAILLE_TOKEN_BAR_LEVELS.length - 1;
  const availableRatio = tokenBudget > 0 ? Math.max(0, Math.min(1, (tokenBudget - tokensUsed) / tokenBudget)) : 0;
  let filled = Math.round(availableRatio * safeWidth * maxLevel);
  let bar = "";
  for (let i = 0; i < safeWidth; i += 1) {
    const level = Math.max(0, Math.min(maxLevel, filled));
    bar += BRAILLE_TOKEN_BAR_LEVELS[level];
    filled -= maxLevel;
  }
  return `[${bar}]`;
}

function goalObjectivePreview(objective, maxLength = 72) {
  const collapsed = String(objective || "").replace(/\s+/g, " ").trim();
  if (!collapsed) return "no objective";
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

function formatProgressMessage(session) {
  const remaining = Math.max(0, Number(session?.token_budget || 0) - Number(session?.tokens_used || 0));
  const phase = String(session?.progress_phase || session?.status || "running").trim() || "running";
  return `Goal ${phase}: ${formatTokenCount(remaining)}/${formatTokenCount(session?.token_budget || 0)} tokens left • ${goalObjectivePreview(session?.objective)}`;
}

function installProgressBridge() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__piclawGoalProgressBridgeInstalled) return;
  window.__piclawGoalProgressBridgeInstalled = true;

  const style = document.createElement("style");
  style.textContent = `
    #piclaw-goal-progress-bridge {
      position: fixed;
      left: max(12px, env(safe-area-inset-left, 0px));
      right: max(12px, env(safe-area-inset-right, 0px));
      bottom: calc(5.75rem + env(safe-area-inset-bottom, 0px));
      z-index: 45;
      display: none;
      pointer-events: none;
    }
    #piclaw-goal-progress-bridge .goal-progress-card {
      width: min(780px, 100%);
      margin: 0 auto;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.45rem 0.7rem;
      border: 1px solid color-mix(in srgb, var(--accent-color, #2563eb) 28%, var(--border-color, rgba(148, 163, 184, 0.45)));
      border-radius: 0.75rem;
      background: color-mix(in srgb, var(--bg-primary, #0f172a) 92%, transparent);
      color: var(--text-primary, #e5e7eb);
      box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);
      font-size: 0.82rem;
      line-height: 1.3;
      backdrop-filter: blur(10px);
    }
    #piclaw-goal-progress-bridge .goal-progress-glyph {
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      color: var(--accent-color, #2563eb);
      white-space: nowrap;
    }
    #piclaw-goal-progress-bridge .goal-progress-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    @media (max-width: 720px) {
      #piclaw-goal-progress-bridge { bottom: calc(5.25rem + env(safe-area-inset-bottom, 0px)); }
      #piclaw-goal-progress-bridge .goal-progress-card { font-size: 0.76rem; padding: 0.38rem 0.55rem; }
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "piclaw-goal-progress-bridge";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  root.innerHTML = `<div class="goal-progress-card"><span class="goal-progress-glyph"></span><span class="goal-progress-text"></span></div>`;
  document.body.appendChild(root);

  let timer = null;
  let inFlight = false;
  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;
  const isVisible = () => document.visibilityState !== "hidden";
  const render = (session) => {
    const active = session?.enabled === true && session?.status === "running" && String(session?.objective || "").trim();
    if (!active) {
      root.style.display = "none";
      return;
    }
    const glyph = root.querySelector(".goal-progress-glyph");
    const text = root.querySelector(".goal-progress-text");
    if (glyph) glyph.textContent = `🎯 ${renderTokenAvailabilityBar(session.tokens_used, session.token_budget)}`;
    if (text) text.textContent = formatProgressMessage(session);
    root.style.display = "block";
  };
  const applySession = (session, { persist = true } = {}) => {
    if (!session || typeof session !== "object") return;
    render(session);
    if (persist) persistCachedProgressSession(session);
  };
  const clearTimer = () => {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = null;
  };
  const nextRefreshDelay = () => {
    const now = Date.now();
    if (circuitOpenUntil > now) return circuitOpenUntil - now;
    if (!consecutiveFailures) return VISIBLE_REFRESH_MS;
    return Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * (2 ** Math.min(4, consecutiveFailures - 1)));
  };
  const refresh = async ({ force = false } = {}) => {
    if (inFlight) return;
    if (!force && !isVisible()) return;
    if (!force && circuitOpenUntil > Date.now()) return;
    inFlight = true;
    try {
      applySession(await loadSession(getCurrentChatJid()));
      consecutiveFailures = 0;
      circuitOpenUntil = 0;
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures >= CIRCUIT_BREAKER_AFTER_FAILURES) {
        circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_MS;
      }
      const cached = readCachedProgressSession(getCurrentChatJid());
      if (cached) render(cached);
      else root.style.display = "none";
    } finally {
      inFlight = false;
    }
  };
  const renderCachedThenRefresh = ({ force = false } = {}) => {
    const cached = readCachedProgressSession(getCurrentChatJid());
    if (cached) applySession(cached, { persist: false });
    void refresh({ force });
  };
  const schedule = () => {
    clearTimer();
    if (!isVisible()) return;
    timer = window.setTimeout(async () => {
      await refresh();
      schedule();
    }, nextRefreshDelay());
  };
  const handleRemoteGoalUpdate = (event) => {
    const payload = event?.detail?.payload || event?.detail || {};
    if (payload?.key === SESSION_UPDATED_KEY) {
      const session = payload.session && typeof payload.session === "object" ? payload.session : payload;
      if (normalizeChatJid(session?.chat_jid || payload.chat_jid) !== getCurrentChatJid()) return;
      applySession(session);
      return;
    }
    if (payload?.key === STATUS_KEY && normalizeChatJid(payload.chat_jid) === getCurrentChatJid()) {
      renderCachedThenRefresh();
    }
  };
  const handleStorageUpdate = (event) => {
    if (event?.key !== progressStorageKey(getCurrentChatJid()) || !event.newValue) return;
    try { applySession(JSON.parse(event.newValue), { persist: false }); } catch {}
  };
  window.addEventListener("piclaw:current-chat-changed", () => { root.style.display = "none"; renderCachedThenRefresh({ force: true }); schedule(); });
  window.addEventListener("piclaw-extension-ui:status", handleRemoteGoalUpdate);
  window.addEventListener("storage", handleStorageUpdate);
  window.addEventListener("focus", () => { renderCachedThenRefresh({ force: true }); schedule(); });
  window.addEventListener("pageshow", () => { renderCachedThenRefresh({ force: true }); schedule(); });
  document.addEventListener("visibilitychange", () => { if (isVisible()) renderCachedThenRefresh({ force: true }); schedule(); });
  renderCachedThenRefresh({ force: true });
  schedule();
}

function removeLegacyProgressBridge() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  try { delete window.__piclawGoalProgressBridgeInstalled; } catch {}
  try { document.getElementById("piclaw-goal-progress-bridge")?.remove(); } catch {}
  try {
    for (const node of Array.from(document.querySelectorAll("style"))) {
      if (String(node.textContent || "").includes("piclaw-goal-progress-bridge")) node.remove();
    }
  } catch {}
}

function registerPane() {
  if (!HAS_RUNTIME) return;
  let reg, notify;
  const registry = globalThis.__piclawSettingsPaneRegistry;
  if (registry) {
    reg = registry.registerSettingsPane;
    notify = registry.notifySettingsPanesChanged;
  }
  if (!reg && globalThis.__piclaw_web?.registerSettingsPane) {
    reg = globalThis.__piclaw_web.registerSettingsPane;
    notify = () => globalThis.dispatchEvent?.(new CustomEvent("piclaw:settings-panes-changed"));
  }
  if (!reg) return;
  reg({ id: ADDON_ID, label: "Goal", icon: ICON, component: GoalSettingsPane, order: 34 });
  notify?.();
}

function GoalSettingsPane() {
  if (!HAS_RUNTIME) return null;
  const [chatJid, setChatJid] = useState(getCurrentChatJid);
  const [config, setConfig] = useState(null);
  const [session, setSession] = useState(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setMessage("");
    const [cfg, sess] = await Promise.all([loadConfig(), loadSession(chatJid)]);
    setConfig(cfg);
    setSession(sess);
  }, [chatJid]);

  useEffect(() => { load().catch((error) => setMessage(String(error?.message || error))); }, [load]);

  useEffect(() => {
    const updateChatJid = () => setChatJid(getCurrentChatJid());
    globalThis.addEventListener?.("piclaw:current-chat-changed", updateChatJid);
    globalThis.addEventListener?.("popstate", updateChatJid);
    return () => {
      globalThis.removeEventListener?.("piclaw:current-chat-changed", updateChatJid);
      globalThis.removeEventListener?.("popstate", updateChatJid);
    };
  }, []);

  const saveGlobal = useCallback(async (patch) => {
    setSaving(true);
    try {
      const result = await saveConfig(patch);
      setConfig(result.config || result);
      setMessage("Saved global goal settings.");
    } catch (error) {
      setMessage(String(error?.message || error));
    } finally {
      setSaving(false);
    }
  }, []);

  const saveCurrentSession = useCallback(async (patch) => {
    setSaving(true);
    try {
      const result = await saveSession(chatJid, patch);
      setSession(result.session || result);
      setMessage("Saved current chat goal settings.");
    } catch (error) {
      setMessage(String(error?.message || error));
    } finally {
      setSaving(false);
    }
  }, [chatJid]);

  const saveSessionTokenBudget = useCallback(async (value) => {
    const tokenBudget = positiveNumber(value, config?.default_token_budget || 1);
    setSession((current) => current ? { ...current, token_budget: tokenBudget } : current);
    await saveCurrentSession({ token_budget: tokenBudget });
  }, [config?.default_token_budget, saveCurrentSession]);

  const saveDefaultTokenBudget = useCallback(async (value) => {
    const tokenBudget = positiveNumber(value, config?.default_token_budget || 1);
    setConfig((current) => current ? { ...current, default_token_budget: tokenBudget } : current);
    setSession((current) => current ? { ...current, token_budget: tokenBudget } : current);
    setSaving(true);
    try {
      const [cfgResult, sessionResult] = await Promise.all([
        saveConfig({ default_token_budget: tokenBudget }),
        saveSession(chatJid, { token_budget: tokenBudget }),
      ]);
      setConfig(cfgResult.config || cfgResult);
      setSession(sessionResult.session || sessionResult);
      setMessage("Saved global default and current chat token budget.");
    } catch (error) {
      setMessage(String(error?.message || error));
    } finally {
      setSaving(false);
    }
  }, [chatJid, config?.default_token_budget]);

  if (!config || !session) {
    return html`<div style="padding:1rem;color:var(--text-secondary)">Loading goal settings…</div>`;
  }

  const S = { display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.45rem 0" };
  const L = { minWidth: "160px", color: "var(--text-secondary)", fontSize: "0.85rem", alignSelf: "flex-start", paddingTop: "0.35rem" };
  const I = { flex: 1, padding: "6px 10px", background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "6px", fontSize: "0.84rem" };
  const PROMPT_TEXTAREA_STYLE = { ...I, minHeight: "110px", fontFamily: "var(--font-mono, monospace)", whiteSpace: "pre", tabSize: "2" };
  const H = { margin: "1.15rem 0 0.45rem", fontSize: "0.9rem", color: "var(--text-primary)", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.3rem" };
  const hint = (text) => html`<div style=${{ fontSize: "0.73rem", color: "var(--text-secondary)", margin: "-0.1rem 0 0.5rem 168px" }}>${text}</div>`;
  const remaining = Math.max(0, Number(session.token_budget || 0) - Number(session.tokens_used || 0));
  const phase = session.progress_phase || session.status;

  return html`
    <div style="padding:0.5rem 0;">
      <h4 style=${H}>Current chat session</h4>
      <div style=${{ fontSize: "0.78rem", color: "var(--text-secondary)", marginBottom: "0.75rem" }}>
        Chat: <code style="font-family:var(--font-mono, monospace)">${chatJid}</code>
      </div>

      <label style=${S}>
        <span style=${L}>Goal seeking enabled</span>
        <input type="checkbox" checked=${!!session.enabled} onChange=${(e) => saveCurrentSession({ enabled: e.target.checked })} disabled=${saving} />
      </label>
      ${hint("Toggle whether this chat keeps auto-continuing an active goal after each turn.")}

      <label style=${S}>
        <span style=${L}>Objective</span>
        <textarea style=${{ ...I, minHeight: "84px" }} value=${session.objective || ""}
          placeholder="Describe the goal for this chat session. Use /goal <objective> to kick off a new run."
          onBlur=${(e) => saveCurrentSession({ objective: e.target.value })}
          disabled=${saving}></textarea>
      </label>
      ${hint("Editing the objective here updates the saved session goal. Use /goal <objective> to start a fresh run immediately.")}

      <label style=${S}>
        <span style=${L}>Token budget</span>
        <input type="number" min="1" step="1000" style=${I} value=${session.token_budget || config.default_token_budget}
          onInput=${(e) => setSession((current) => current ? { ...current, token_budget: positiveNumber(e.target.value, config.default_token_budget) } : current)}
          onBlur=${(e) => saveSessionTokenBudget(e.target.value)}
          disabled=${saving} />
      </label>
      ${hint(`Used ${formatTokenCount(session.tokens_used || 0)} tokens so far, ${formatTokenCount(remaining)} remaining. Status: ${session.status}; phase: ${phase}.`) }

      <div style=${{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "0.35rem" }}>
        <button onClick=${() => saveCurrentSession({ enabled: true })} disabled=${saving}>Turn On</button>
        <button onClick=${() => saveCurrentSession({ enabled: false })} disabled=${saving}>Turn Off</button>
        <button onClick=${() => saveCurrentSession({ objective: "", enabled: false, status: "idle", token_budget: config.default_token_budget })} disabled=${saving}>Clear session goal</button>
        <button onClick=${() => load()} disabled=${saving}>Refresh</button>
      </div>
      <div style=${{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.65rem" }}>
        Use <code>/goal &lt;objective&gt;</code> to start a goal run, <code>/goal status</code> to inspect it, and <code>/goal off</code> to pause it from chat.
      </div>

      <h4 style=${H}>Prompt templates</h4>

      <label style=${S}>
        <span style=${L}>Default token budget</span>
        <input type="number" min="1" step="1000" style=${I} value=${config.default_token_budget}
          onInput=${(e) => setConfig((current) => current ? { ...current, default_token_budget: positiveNumber(e.target.value, current.default_token_budget) } : current)}
          onBlur=${(e) => saveDefaultTokenBudget(e.target.value)}
          disabled=${saving} />
      </label>

      <label style=${S}>
        <span style=${L}>System prompt</span>
        <textarea style=${PROMPT_TEXTAREA_STYLE} value=${config.system_prompt}
          spellcheck="false"
          onBlur=${(e) => saveGlobal({ system_prompt: e.target.value })}
          disabled=${saving}></textarea>
      </label>

      <label style=${S}>
        <span style=${L}>Continuation prompt</span>
        <textarea style=${{ ...PROMPT_TEXTAREA_STYLE, minHeight: "220px" }} value=${config.continuation_prompt}
          spellcheck="false"
          onBlur=${(e) => saveGlobal({ continuation_prompt: e.target.value })}
          disabled=${saving}></textarea>
      </label>

      <label style=${S}>
        <span style=${L}>Budget-limit prompt</span>
        <textarea style=${{ ...PROMPT_TEXTAREA_STYLE, minHeight: "170px" }} value=${config.budget_limit_prompt}
          spellcheck="false"
          onBlur=${(e) => saveGlobal({ budget_limit_prompt: e.target.value })}
          disabled=${saving}></textarea>
      </label>
      ${hint("Available placeholders: {{ objective }}, {{ time_used_seconds }}, {{ tokens_used }}, {{ token_budget }}, {{ remaining_tokens }}, {{ status }}, {{ chat_jid }}, {{ completion_summary }}")}

      ${message ? html`<div style=${{ marginTop: "0.75rem", fontSize: "0.8rem", color: /failed|error/i.test(message) ? "var(--danger-color,#dc2626)" : "var(--accent-color,#2563eb)" }}>${message}</div>` : null}
    </div>`;
}

try {
  removeLegacyProgressBridge();
  registerPane();
  if (typeof window !== "undefined") {
    window.addEventListener("piclaw:addons-loaded", () => { try { removeLegacyProgressBridge(); registerPane(); } catch {} });
  }
} catch {}
