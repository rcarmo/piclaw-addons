// @ts-nocheck
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

  if (!cfg) return html`<div style="padding:1rem;color:var(--text-secondary)">Loading…</div>`;

  const S = { display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.4rem 0" };
  const L = { minWidth: "160px", color: "var(--text-secondary)", fontSize: "0.85rem" };
  const I = { flex: 1, padding: "4px 8px", background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", fontSize: "0.85rem", fontFamily: "var(--font-mono, monospace)" };
  const H = { margin: "1.2rem 0 0.4rem", fontSize: "0.9rem", color: "var(--text-primary)", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.3rem" };
  const hint = (t) => html`<div style=${{ fontSize: "0.73rem", color: "var(--text-secondary)", margin: "-0.15rem 0 0.4rem 168px" }}>${t}</div>`;

  return html`
    <div style="padding:0.5rem 0;">
      <h4 style=${H}>Output</h4>
      <label style=${S}>
        <span style=${L}>Output file</span>
        <input
          type="text"
          value=${cfg.output_path ?? DEFAULT_OUTPUT_PATH}
          style=${I}
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

      <h4 style=${H}>Attribution</h4>
      <div style=${{ fontSize: "0.84rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
        <span>Adapted from </span>
        <a href="https://github.com/IgorWarzocha/pi-vent" target="_blank" rel="noreferrer">pi-vent</a>
        <span> by Igor Warzocha (MIT). This add-on keeps the same major-issue vent workflow, but lets you choose the output file.</span>
      </div>

      ${msg && html`<div style=${{ marginTop: "0.75rem", fontSize: "0.8rem", color: msg.includes("failed") || msg.includes("Failed") ? "var(--danger-color)" : "var(--accent-color)" }}>${msg}</div>`}
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
