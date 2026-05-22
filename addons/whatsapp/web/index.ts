/**
 * web/index.ts — Browser-side settings pane for @rcarmo/piclaw-addon-whatsapp.
 */
const { html, useState, useEffect, useCallback } = (globalThis as any).__piclawPreactHtm || (globalThis as any).__piclawPreact || {};
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

const ADDON_ID = "whatsapp";

const ICON = HAS_RUNTIME
  ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`
  : null;

interface WhatsAppConfig {
  phone: string;
  enabled: boolean;
  connected: boolean;
  pairingCode: string | null;
}

function WhatsAppSettings() {
  if (!HAS_RUNTIME) return null;

  const [config, setConfig] = useState<WhatsAppConfig>({ phone: "", enabled: false, connected: false, pairingCode: null });
  const [saving, setSaving] = useState(false);
  const [phone, setPhone] = useState("");
  const [enabled, setEnabled] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch(`/agent/addons/api/${ADDON_ID}/config`);
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
        setPhone(data.phone || "");
        setEnabled(data.enabled ?? false);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const saveConfig = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(`/agent/addons/api/${ADDON_ID}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, enabled }),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
      }
    } catch { /* ignore */ }
    setSaving(false);
  }, [phone, enabled]);

  return html`
    <section>
      <h3 style="margin: 0 0 12px 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-primary, #e7e9ea); border-bottom: 1px solid var(--border, #2f3336); padding-bottom: 6px;">
        WhatsApp Channel
      </h3>

      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">
        <label style="font-size: 13px; color: var(--text-secondary, #71767b); min-width: 120px; text-align: right;">Enabled</label>
        <input type="checkbox" checked=${enabled} onChange=${(e: any) => setEnabled(e.target.checked)} />
        <span style="font-size: 12px; color: var(--text-secondary, #71767b);">
          ${config.connected ? "✅ Connected" : "⏸ Disconnected"}
        </span>
      </div>

      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">
        <label style="font-size: 13px; color: var(--text-secondary, #71767b); min-width: 120px; text-align: right;">Phone</label>
        <input
          type="text"
          value=${phone}
          placeholder="+1234567890"
          onInput=${(e: any) => setPhone(e.target.value)}
          style="background: var(--bg-elevated, #1a1a2e); border: 1px solid var(--border, #2f3336); color: var(--text-primary, #e7e9ea); padding: 5px 10px; border-radius: 3px; font-size: 13px; width: 180px;"
        />
      </div>

      ${config.pairingCode && html`
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">
          <label style="font-size: 13px; color: var(--text-secondary, #71767b); min-width: 120px; text-align: right;">Pairing Code</label>
          <code style="font-size: 16px; font-weight: bold; letter-spacing: 2px; color: var(--accent, #1d9bf0);">${config.pairingCode}</code>
        </div>
      `}

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
        After saving, restart PiClaw for changes to take effect. The pairing code appears on first connection — enter it in your WhatsApp app under Linked Devices.
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
  reg({ id: ADDON_ID, label: "WhatsApp", icon: ICON, component: WhatsAppSettings, order: 175 });
  notify?.();
}
