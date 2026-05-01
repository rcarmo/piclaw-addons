// @ts-nocheck
const ADDON_ID = "goal";
const API = `/agent/addons/api/${ADDON_ID}`;
const DEFAULT_CHAT_JID = "web:default";

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
  const chatJid = getCurrentChatJid();
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
          onBlur=${(e) => saveCurrentSession({ token_budget: Number(e.target.value || 0) })}
          disabled=${saving} />
      </label>
      ${hint(`Used ${session.tokens_used || 0} tokens so far, ${remaining} remaining. Status: ${session.status}.`) }

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
          onBlur=${(e) => saveGlobal({ default_token_budget: Number(e.target.value || 0) })}
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
  registerPane();
  if (typeof window !== "undefined") {
    window.addEventListener("piclaw:addons-loaded", () => { try { registerPane(); } catch {} });
  }
} catch {}
