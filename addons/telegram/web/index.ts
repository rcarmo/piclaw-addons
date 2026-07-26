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

  const [config, setConfig] = useState<any>({ enabled: false, pollingTimeout: 30, connected: false, botTokenConfigured: false });
  const [saving, setSaving] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [enabled, setEnabled] = useState(false);
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
        setPollingTimeout(data.pollingTimeout ?? 30);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const saveConfig = useCallback(async () => {
    setSaving(true);
    try {
      const nextToken = botToken.trim();
      if (nextToken && !(await saveKeychainToken(nextToken))) throw new Error("Failed to save Telegram token to keychain");
      const body: any = { enabled, pollingTimeout };
      const res = await fetch(`/agent/addons/api/${ADDON_ID}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig({ ...data, botTokenConfigured: data.botTokenConfigured || Boolean(nextToken) || config.botTokenConfigured });
        setBotToken("");
      }
    } catch { /* ignore */ }
    setSaving(false);
  }, [botToken, config.botTokenConfigured, enabled, pollingTimeout]);

  return html`
    <section>
      <h3 style="margin: 0 0 12px 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-primary, #e7e9ea); border-bottom: 1px solid var(--border, #2f3336); padding-bottom: 6px;">
        Telegram Bot Channel
      </h3>

      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">
        <label style="font-size: 13px; color: var(--text-secondary, #71767b); min-width: 120px; text-align: right;">Enabled</label>
        <input type="checkbox" checked=${enabled} onChange=${(e: any) => setEnabled(e.target.checked)} />
        <span style="font-size: 12px; color: var(--text-secondary, #71767b);">
          ${config.connected ? "✅ Connected" : "⏸ Disconnected"}
        </span>
      </div>

      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">
        <label style="font-size: 13px; color: var(--text-secondary, #71767b); min-width: 120px; text-align: right;">Bot Token</label>
        <input
          type="password"
          value=${botToken}
          placeholder=${config.botTokenConfigured ? "••••••• (stored in keychain)" : "123456:ABC-DEF..."}
          onInput=${(e: any) => setBotToken(e.target.value)}
          style="background: var(--bg-elevated, #1a1a2e); border: 1px solid var(--border, #2f3336); color: var(--text-primary, #e7e9ea); padding: 5px 10px; border-radius: 3px; font-size: 13px; width: 240px;"
        />
      </div>

      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">
        <label style="font-size: 13px; color: var(--text-secondary, #71767b); min-width: 120px; text-align: right;">Poll Timeout</label>
        <input
          type="number"
          value=${pollingTimeout}
          min="5"
          max="120"
          onInput=${(e: any) => setPollingTimeout(Number(e.target.value) || 30)}
          style="background: var(--bg-elevated, #1a1a2e); border: 1px solid var(--border, #2f3336); color: var(--text-primary, #e7e9ea); padding: 5px 10px; border-radius: 3px; font-size: 13px; width: 80px;"
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

      <p style="font-size: 11px; color: var(--text-secondary, #71767b); margin-top: 12px;">
        Create a bot via <a href="https://t.me/BotFather" target="_blank" style="color: var(--accent, #1d9bf0);">@BotFather</a> on Telegram. The token is stored in keychain entry <code>${BOT_TOKEN_KEYCHAIN}</code>. Restart PiClaw after changing it.
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
