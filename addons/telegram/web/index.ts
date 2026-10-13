import { settingsFieldStyles } from "./settings-fields.ts";
/**
 * web/index.ts — Browser-side settings pane for @rcarmo/piclaw-addon-telegram.
 */
const { html, useState, useEffect, useCallback } = (globalThis as any).__piclawPreactHtm || (globalThis as any).__piclawPreact || {};
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

const ADDON_ID = "telegram";
const BOT_TOKEN_KEYCHAIN = "telegram/bot-token";

async function keychainHas(name: string): Promise<boolean> {
  try {
    const res = await fetch("/agent/keychain");
    if (!res.ok) return false;
    const data = await res.json();
    return (data.entries || []).some((entry: any) => entry?.name === name);
  } catch { return false; }
}

async function saveKeychainToken(secret: string): Promise<boolean> {
  try {
    const res = await fetch("/agent/keychain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: BOT_TOKEN_KEYCHAIN, secret, type: "token" }),
    });
    return res.ok;
  } catch { return false; }
}

const ICON = HAS_RUNTIME
  ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>`
  : null;

function TelegramSettings() {
  if (!HAS_RUNTIME) return null;

  const [config, setConfig] = useState({ enabled: false, pollingTimeout: 30, connected: false, botTokenConfigured: false, status: "", targets: [] as any[] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [botToken, setBotToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [allowedUserIds, setAllowedUserIds] = useState("");
  const [targetChatJid, setTargetChatJid] = useState("");
  const [targetIncarnation, setTargetIncarnation] = useState("");
  const [pollingTimeout, setPollingTimeout] = useState(30);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch(`/agent/addons/api/${ADDON_ID}/config`);
      if (res.ok) {
        const data = await res.json();
        const botTokenConfigured = data.botTokenConfigured || await keychainHas(BOT_TOKEN_KEYCHAIN);
        setConfig({ ...data, botTokenConfigured });
        setBotToken("");
        setEnabled(data.enabled ?? false);
        setAllowedUserIds(Array.isArray(data.allowedUserIds) ? data.allowedUserIds.join(", ") : "");
        setTargetChatJid(data.targetChatJid ?? "");
        setTargetIncarnation(data.targetIncarnation ?? "");
        setPollingTimeout(data.pollingTimeout ?? 30);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const saveConfig = useCallback(async () => {
    setSaving(true);
    setError("");
    try {
      const nextToken = botToken.trim();
      if (nextToken && !(await saveKeychainToken(nextToken))) throw new Error("Failed to save Telegram token to keychain.");
      const body: any = { enabled, allowedUserIds, targetChatJid, targetIncarnation, pollingTimeout };
      const res = await fetch(`/agent/addons/api/${ADDON_ID}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed. Check the user IDs and the target chat.");
      setConfig({ ...data, botTokenConfigured: data.botTokenConfigured || Boolean(nextToken) || config.botTokenConfigured });
      setBotToken("");
    } catch (err: any) {
      setError(err?.message || "Save failed.");
      await loadConfig();
    }
    setSaving(false);
  }, [botToken, config.botTokenConfigured, enabled, allowedUserIds, targetChatJid, targetIncarnation, pollingTimeout, loadConfig]);

  return html`
    <section data-settings-addon="telegram">
      <style>${settingsFieldStyles}</style>
      <h3 style="margin: 0 0 12px 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-primary, #e7e9ea); border-bottom: 1px solid var(--border, #2f3336); padding-bottom: 6px;">
        Telegram Bot Channel
      </h3>

      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">
        <label style="font-size: 13px; color: var(--text-secondary, #71767b); min-width: 120px; text-align: right;">Enabled</label>
        <input type="checkbox" checked=${enabled} onChange=${(e: any) => setEnabled(e.target.checked)} />
        <span style="font-size: 12px; color: var(--text-secondary, #71767b);">
          ${config.connected ? "✅ Connected" : "⏸ Disconnected"}${config.status ? ` — ${config.status}` : ""}
        </span>
      </div>

      <div class="settings-addon-field">
        <label class="settings-addon-label" for="telegram-token">Bot Token</label>
        <input class="settings-addon-control" id="telegram-token"
          type="password"
          value=${botToken}
          placeholder=${config.botTokenConfigured ? "••••••• (stored in keychain)" : "123456:ABC-DEF..."}
          onInput=${(e: any) => setBotToken(e.target.value)}
        />
      </div>

      <div class="settings-addon-field">
        <label class="settings-addon-label" for="telegram-users">Allowed Telegram user IDs</label>
        <input class="settings-addon-control" id="telegram-users"
          type="text"
          inputmode="numeric"
          value=${allowedUserIds}
          placeholder="123456789"
          onInput=${(e: any) => setAllowedUserIds(e.target.value)}
        />
        <span class="settings-addon-help">Numeric user IDs, comma separated. Only private chats with these users are accepted; with no IDs the channel stays off.</span>
      </div>

      <div class="settings-addon-field">
        <label class="settings-addon-label" for="telegram-target">Target chat</label>
        <select class="settings-addon-control" id="telegram-target" value=${JSON.stringify([targetChatJid, targetIncarnation])} onChange=${(e: any) => {
          const [jid, incarnation] = JSON.parse(e.target.value);
          setTargetChatJid(jid);
          setTargetIncarnation(incarnation);
        }}>
          <option value=${JSON.stringify(["", ""])}>Select a dedicated chat</option>
          ${(config.targets || []).map((t: any) => html`<option value=${JSON.stringify([t.chatJid, t.incarnation])}>${t.label || t.chatJid} — ${t.incarnation.slice(0, 8)} (${t.chatJid})</option>`)}
        </select>
        <span class="settings-addon-help">An existing web chat used only for Telegram (not web:default). Inbound agent access is currently unavailable; no messages are forwarded to the agent.</span>
      </div>

      <div class="settings-addon-field">
        <label class="settings-addon-label" for="telegram-timeout">Poll Timeout</label>
        <input class="settings-addon-control" id="telegram-timeout"
          type="number"
          value=${pollingTimeout}
          min="5"
          max="120"
          onInput=${(e: any) => setPollingTimeout(Number(e.target.value) || 30)}
        />
        <span style="font-size: 12px; color: var(--text-secondary, #71767b);">seconds</span>
      </div>

      <div style="display: flex; justify-content: flex-end; margin-top: 16px;">
        <button
          onClick=${saveConfig}
          disabled=${saving}
          style="padding: 6px 16px; border-radius: 4px; border: 1px solid var(--border, #2f3336); background: var(--bg-elevated, #1a1a2e); color: var(--text-primary, #e7e9ea); cursor: pointer; font-size: 13px;"
        >
          ${saving ? "Saving…" : "Save"}
        </button>
      </div>

      <p class="settings-addon-help" role="status">${error}</p>

      <p style="font-size: 11px; color: var(--text-secondary, #71767b); margin-top: 12px;">
        Create a bot via <a href="https://t.me/BotFather" target="_blank" style="color: var(--accent, #1d9bf0);">@BotFather</a> on Telegram. The token is stored in keychain entry <code>${BOT_TOKEN_KEYCHAIN}</code>. Saving applies the settings immediately.
        Inbound agent access is disabled until Piclaw supports unattended host-bound dispatch; /start reports that agent access is unavailable.
        If PICLAW_TELEGRAM_ENABLED=1 enables Telegram through the environment, Settings disable is rejected; unset that override first.
      </p>
    </section>
  `;
}

// Register settings pane
const r = (globalThis as any).__piclawSettingsPaneRegistry;
let reg: ((def: any) => void) | null = null;
let notify: (() => void) | null = null;
if (r) { reg = r.registerSettingsPane; notify = r.notifySettingsPanesChanged; }
if (!reg && (globalThis as any).__piclaw_web?.registerSettingsPane) {
  reg = (globalThis as any).__piclaw_web.registerSettingsPane;
  notify = (globalThis as any).__piclaw_web.notifySettingsPanesChanged;
}
if (reg) {
  reg({ id: ADDON_ID, label: "Telegram", icon: ICON, component: TelegramSettings, order: 176 });
  notify?.();
}
