// @ts-nocheck
import { settingsFieldStyles } from "./settings-fields.ts";
const ADDON_ID = "vent";
const API = `/agent/addons/api/${ADDON_ID}`;
const DEFAULT_OUTPUT_PATH = "VENT.md";

const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
const html = preactHtm?.html;
const useState = preactHtm?.useState;
const useEffect = preactHtm?.useEffect;
const useCallback = preactHtm?.useCallback;
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

const ICON = HAS_RUNTIME
  ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"></path><path d="M4 12h10"></path><path d="M4 18h7"></path><path d="M18 10l2 2-2 2"></path></svg>`
  : null;

async function loadConfig() {
  try {
    const r = await fetch(`${API}/config`);
    return r.ok ? await r.json() : { output_path: DEFAULT_OUTPUT_PATH };
  } catch {
    return { output_path: DEFAULT_OUTPUT_PATH };
  }
}

async function saveConfig(patch) {
  try {
    const r = await fetch(`${API}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return r.ok ? await r.json() : { ok: false, error: "Save failed" };
  } catch {
    return { ok: false, error: "Save failed" };
  }
}

function VentSettings() {
  if (!HAS_RUNTIME) return null;
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setCfg(await loadConfig());
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (patch) => {
    setSaving(true);
    setMsg("");
    const result = await saveConfig(patch);
    if (result.ok && result.config) {
      setCfg(result.config);
      setMsg("Saved.");
      setTimeout(() => setMsg(""), 2500);
    } else {
      setMsg(result.error || "Save failed.");
    }
    setSaving(false);
  }, []);

  if (!cfg) return html`<p class="settings-addon-status" role="status">Loading…</p>`;

  const hint = (t) => html`<p class="settings-addon-help">${t}</p>`;

  return html`
    <div data-settings-addon="vent" class="settings-addon-section">
      <style>${settingsFieldStyles}</style>
      <h4 class="settings-addon-heading">Output</h4>
      <label class="settings-addon-field">
        <span class="settings-addon-label">Output file</span>
        <input class="settings-addon-control"
          type="text"
          value=${cfg.output_path ?? DEFAULT_OUTPUT_PATH}
          placeholder=${DEFAULT_OUTPUT_PATH}
          onBlur=${(e) => {
            if (e.target.value !== (cfg.output_path ?? DEFAULT_OUTPUT_PATH)) {
              save({ output_path: e.target.value });
            }
          }}
          onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }}
          disabled=${saving}
        />
      </label>
      ${hint("Relative to the current workspace. Nested paths are allowed and missing directories are created automatically.")}

      <h4 class="settings-addon-heading">Attribution</h4>
      <p class="settings-addon-help">
        Adapted from <a href="https://github.com/IgorWarzocha/pi-vent" target="_blank" rel="noreferrer">pi-vent</a>
        by Igor Warzocha (MIT). This add-on keeps the same major-issue vent workflow, but lets you choose the output file.
      </p>

      ${msg && (/failed/i.test(msg)
        ? html`<p class="settings-addon-error" role="alert">${msg}</p>`
        : html`<p class="settings-addon-status" role="status">${msg}</p>`)}
    </div>`;
}

try {
  if (HAS_RUNTIME) {
    let reg, notify;
    const r = globalThis.__piclawSettingsPaneRegistry;
    if (r) { reg = r.registerSettingsPane; notify = r.notifySettingsPanesChanged; }
    if (!reg && globalThis.__piclaw_web?.registerSettingsPane) {
      reg = globalThis.__piclaw_web.registerSettingsPane;
      notify = () => globalThis.dispatchEvent?.(new CustomEvent("piclaw:settings-panes-changed"));
    }
    if (reg) {
      reg({ id: "vent", label: "Vent", icon: ICON, component: VentSettings, order: 181 });
      notify?.();
    }
  }
} catch {}
