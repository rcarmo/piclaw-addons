import { settingsFieldStyles } from "./settings-fields.ts";
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

  const [config, setConfig] = useState({ phone: "", enabled: false, connected: false, pairingCode: null } as WhatsAppConfig);
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
    <section data-settings-addon="whatsapp" class="settings-addon-section">
      <style>${settingsFieldStyles}</style>
      <h3 class="settings-addon-heading">WhatsApp channel</h3>

      <div class="settings-addon-control-group">
        <label class="settings-addon-check">
          <input type="checkbox" checked=${enabled} onChange=${(e: any) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <span class="settings-addon-badge" role="status" data-tone=${config.connected ? "success" : undefined}>${config.connected ? "Connected" : "Disconnected"}</span>
      </div>

      <div class="settings-addon-field">
        <label class="settings-addon-label" for="whatsapp-phone">Phone</label>
        <input class="settings-addon-control" id="whatsapp-phone"
          type="text"
          value=${phone}
          placeholder="+1234567890"
          onInput=${(e: any) => setPhone(e.target.value)}
        />
      </div>

      ${config.pairingCode && html`
        <div class="settings-addon-field">
          <span class="settings-addon-label" id="whatsapp-pairing-label">Pairing code</span>
          <code class="settings-addon-callout" data-tone="info" aria-labelledby="whatsapp-pairing-label">${config.pairingCode}</code>
        </div>
      `}

      <div class="settings-addon-actions">
        <button type="button" data-settings-button="primary" onClick=${saveConfig} disabled=${saving}>
          ${saving ? "Saving…" : "Save"}
        </button>
      </div>

      <p class="settings-addon-help">
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
