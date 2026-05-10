// @ts-nocheck
const ADDON_ID = "delegate";
const API = `/agent/addons/api/${ADDON_ID}`;

const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
const html = preactHtm?.html;
const useState = preactHtm?.useState;
const useEffect = preactHtm?.useEffect;
const useCallback = preactHtm?.useCallback;
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

const ICON = HAS_RUNTIME
  ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10H7z"/><path d="M4 4h4"/><path d="M16 4h4"/><path d="M4 20h4"/><path d="M16 20h4"/></svg>`
  : null;

async function apiJson(path, options) {
  const response = await fetch(`${API}/${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function DelegateSettings() {
  if (!HAS_RUNTIME) return null;
  const [config, setConfig] = useState(null);
  const [providers, setProviders] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async (refresh = false) => {
    setSaving(true);
    setMessage(refresh ? "Refreshing models…" : "");
    try {
      const payload = refresh
        ? await apiJson("models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh: true }) })
        : await apiJson("models");
      setConfig(payload.config || { searchable_providers: null });
      setProviders(payload.providers || []);
      setCandidates(payload.candidates || []);
      setMessage(refresh ? "Model list refreshed." : "");
      if (refresh) setTimeout(() => setMessage(""), 2500);
    } catch (error) {
      setMessage(error?.message || "Failed to load delegate settings.");
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const saveProviders = useCallback(async (nextProviders) => {
    setSaving(true);
    setMessage("");
    try {
      const payload = await apiJson("config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchable_providers: nextProviders }),
      });
      setConfig(payload.config || { searchable_providers: nextProviders });
      await load(false);
      setMessage("Saved provider list.");
      setTimeout(() => setMessage(""), 2200);
    } catch (error) {
      setMessage(error?.message || "Failed to save provider list.");
    } finally {
      setSaving(false);
    }
  }, [load]);

  if (!config) return html`<div style="padding:1rem;color:var(--text-secondary)">Loading delegate settings…</div>`;

  const enabledSet = new Set(Array.isArray(config.searchable_providers)
    ? config.searchable_providers
    : providers.filter((provider) => provider.enabled).map((provider) => provider.provider));
  const q = filter.trim().toLowerCase();
  const visibleProviders = providers.filter((provider) => !q || provider.provider.toLowerCase().includes(q));

  const S = { display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.45rem 0" };
  const I = { width: "100%", padding: "6px 10px", background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "6px", fontSize: "0.84rem" };
  const H = { margin: "1.2rem 0 0.45rem", fontSize: "0.9rem", color: "var(--text-primary)", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.3rem" };
  const buttonStyle = "padding:4px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:0.82rem";

  return html`
    <div style="padding:0.5rem 0;">
      <h4 style=${H}>Searchable providers</h4>
      <div style=${{ fontSize: "0.78rem", color: "var(--text-secondary)", lineHeight: 1.45, marginBottom: "0.7rem" }}>
        Delegate searches for close matches to its Copilot reference model list across checked providers. Providers starting with <code>azure-</code> are always blacklisted.
      </div>
      <div style=${{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "0.65rem" }}>
        <input style=${I} type="search" value=${filter} placeholder="Filter providers…" onInput=${(e) => setFilter(e.target.value)} />
        <button type="button" style=${buttonStyle} disabled=${saving} onClick=${() => load(true)}>Refresh</button>
      </div>
      <div style=${{ display: "grid", gap: "0.35rem" }}>
        ${visibleProviders.map((provider) => {
          const checked = enabledSet.has(provider.provider) && !provider.blacklisted;
          return html`
            <label key=${provider.provider} style=${{ ...S, opacity: provider.blacklisted ? 0.55 : 1 }}>
              <input type="checkbox" checked=${checked} disabled=${saving || provider.blacklisted}
                onChange=${(e) => {
                  const next = new Set(enabledSet);
                  if (e.target.checked) next.add(provider.provider);
                  else next.delete(provider.provider);
                  saveProviders([...next].sort());
                }} />
              <span style=${{ minWidth: "150px", fontFamily: "var(--font-mono, monospace)", fontSize: "0.82rem" }}>${provider.provider}</span>
              <span style=${{ color: "var(--text-secondary)", fontSize: "0.76rem" }}>${provider.modelCount} models${provider.blacklisted ? " · blacklisted" : ""}</span>
            </label>`;
        })}
      </div>

      <h4 style=${H}>Matched delegate candidates</h4>
      <div style=${{ fontSize: "0.78rem", color: "var(--text-secondary)", marginBottom: "0.45rem" }}>
        ${candidates.length} close model matches found across selected providers.
      </div>
      <div style=${{ maxHeight: "180px", overflow: "auto", border: "1px solid var(--border-color)", borderRadius: "6px" }}>
        ${candidates.slice(0, 80).map((candidate) => html`
          <div key=${`${candidate.id}:${candidate.sourceId}`} style=${{ display: "grid", gridTemplateColumns: "3rem 1fr", gap: "0.5rem", padding: "0.35rem 0.5rem", borderBottom: "1px solid var(--border-color)", fontSize: "0.76rem" }}>
            <span style="color:var(--text-secondary)">T${candidate.tier}</span>
            <span><code>${candidate.id}</code> <span style="color:var(--text-secondary)">← ${candidate.sourceId} (${candidate.matchScore})</span></span>
          </div>`)}
      </div>
      ${message && html`<div style=${{ marginTop: "0.75rem", fontSize: "0.8rem", color: /failed|error/i.test(message) ? "var(--danger-color)" : "var(--accent-color)" }}>${message}</div>`}
    </div>`;
}

try {
  if (HAS_RUNTIME) {
    let reg, notify;
    const registry = globalThis.__piclawSettingsPaneRegistry;
    if (registry) { reg = registry.registerSettingsPane; notify = registry.notifySettingsPanesChanged; }
    if (!reg && globalThis.__piclaw_web?.registerSettingsPane) {
      reg = globalThis.__piclaw_web.registerSettingsPane;
      notify = () => globalThis.dispatchEvent?.(new CustomEvent("piclaw:settings-panes-changed"));
    }
    if (reg) {
      reg({ id: ADDON_ID, label: "Delegate", icon: ICON, component: DelegateSettings, order: 169 });
      notify?.();
    }
  }
} catch {}
