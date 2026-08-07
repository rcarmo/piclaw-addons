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

function formatTimestamp(value) {
  if (!value) return "never";
  try { return new Date(value).toLocaleString(); } catch { return "unknown"; }
}

function formatAge(value) {
  if (!value) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - Number(value)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function compactTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export function resolveProviderMode(provider, searchableProviders) {
  return searchableProviders.has(provider) ? "search" : "exclude";
}

export function buildProviderModePatch(provider, mode, discoveredProviders, searchableProviders) {
  const searchableSource = [...searchableProviders];
  const searchable = searchableSource.filter((item) => item !== provider);
  if (mode === "search") {
    const originalIndex = searchableSource.indexOf(provider);
    if (originalIndex >= 0) searchable.splice(Math.min(originalIndex, searchable.length), 0, provider);
    else searchable.push(provider);
  }
  const searchableSet = new Set(searchable);
  return {
    searchable_providers: searchable,
    excluded_providers: [...discoveredProviders].filter((item) => !searchableSet.has(item)),
  };
}

function DelegateSettings() {
  if (!HAS_RUNTIME) return null;
  const [config, setConfig] = useState(null);
  const [providers, setProviders] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [filter, setFilter] = useState("");
  const [excludedModelsText, setExcludedModelsText] = useState("");
  const [cli, setCli] = useState("");
  const [discoveryError, setDiscoveryError] = useState("");
  const [cache, setCache] = useState({});
  const [runtimeCatalog, setRuntimeCatalog] = useState({});
  const [executableCatalog, setExecutableCatalog] = useState({});
  const [runtimeOnlyModels, setRuntimeOnlyModels] = useState([]);
  const [unclassifiedModels, setUnclassifiedModels] = useState([]);
  const [rejectedModels, setRejectedModels] = useState([]);
  const [effectiveExclusions, setEffectiveExclusions] = useState({ providers: [], models: [] });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async (refresh = false, throwOnError = false) => {
    setSaving(true);
    setMessage(refresh ? "Refreshing models…" : "");
    try {
      const payload = refresh
        ? await apiJson("models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh: true }) })
        : await apiJson("models");
      const nextConfig = payload.config || { searchable_providers: null, excluded_providers: null, excluded_models: [] };
      setConfig(nextConfig);
      setExcludedModelsText(Array.isArray(nextConfig.excluded_models) ? nextConfig.excluded_models.join("\n") : "");
      setProviders(payload.providers || []);
      setCandidates(payload.candidates || []);
      setCli(payload.cli || "");
      setDiscoveryError(payload.discovery_error || "");
      setCache(payload.cache || {});
      setRuntimeCatalog(payload.runtime_catalog || {});
      setExecutableCatalog(payload.executable_catalog || {});
      setRuntimeOnlyModels(payload.runtime_only_models || []);
      setUnclassifiedModels(payload.unclassified_models || []);
      setRejectedModels(payload.rejected_models || []);
      setEffectiveExclusions(payload.effective_exclusions || { providers: [], models: [] });
      setMessage(refresh ? "Model list refreshed." : "");
      if (refresh) setTimeout(() => setMessage(""), 2500);
    } catch (error) {
      setMessage(error?.message || "Failed to load delegate settings.");
      if (throwOnError) throw error;
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const saveConfigPatch = useCallback(async (patch, successMessage = "Saved delegate settings.") => {
    const previousConfig = config;
    const optimisticConfig = { ...config, ...patch };
    setConfig(optimisticConfig);
    setSaving(true);
    setMessage("");
    let nextConfig;
    try {
      const payload = await apiJson("config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      nextConfig = payload.config || optimisticConfig;
      setConfig(nextConfig);
      setExcludedModelsText(Array.isArray(nextConfig.excluded_models) ? nextConfig.excluded_models.join("\n") : "");
    } catch (error) {
      setConfig(previousConfig);
      setExcludedModelsText(Array.isArray(previousConfig?.excluded_models) ? previousConfig.excluded_models.join("\n") : "");
      setMessage(error?.message || "Failed to save delegate settings.");
      setSaving(false);
      return;
    }
    try {
      await load(false, true);
      setMessage(successMessage);
      setTimeout(() => setMessage(""), 2200);
    } catch (error) {
      setConfig(nextConfig);
      setMessage(`${successMessage} Refresh failed: ${error?.message || "unknown error"}`);
    } finally {
      setSaving(false);
    }
  }, [config, load]);

  const saveProviderMode = useCallback((provider, mode, discoveredProviders, searchableProviders) => {
    const patch = buildProviderModePatch(provider, mode, discoveredProviders, searchableProviders);
    saveConfigPatch(patch, `Set ${provider} to ${mode}.`);
  }, [saveConfigPatch]);
  const saveExcludedModels = useCallback(() => {
    const patterns = excludedModelsText.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean).sort();
    saveConfigPatch({ excluded_models: patterns }, "Saved model exclusions.");
  }, [excludedModelsText, saveConfigPatch]);

  if (!config) return html`<div style="padding:1rem;color:var(--text-secondary)">Loading delegate settings…</div>`;

  const enabledSet = new Set(Array.isArray(config.searchable_providers)
    ? config.searchable_providers
    : providers.filter((provider) => provider.enabled).map((provider) => provider.provider));
  const excludedSet = new Set(Array.isArray(config.excluded_providers)
    ? config.excluded_providers
    : providers.filter((provider) => provider.excluded).map((provider) => provider.provider));
  const q = filter.trim().toLowerCase();
  const visibleProviders = providers.filter((provider) => !q || provider.provider.toLowerCase().includes(q));

  const S = { display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.45rem 0" };
  const I = { width: "100%", padding: "6px 10px", background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "6px", fontSize: "0.84rem" };
  const H = { margin: "1.2rem 0 0.45rem", fontSize: "0.9rem", color: "var(--text-primary)", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.3rem" };
  const buttonStyle = "padding:4px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:0.82rem";
  const cardStyle = { padding: "0.55rem 0.65rem", border: "1px solid var(--border-color)", borderRadius: "7px", background: "var(--bg-secondary)" };

  return html`
    <div style="padding:0.5rem 0;">
      <h4 style=${H}>Catalog status</h4>
      <div style=${{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "0.45rem", marginBottom: "0.6rem" }}>
        <div style=${cardStyle}><div style="font-size:1.05rem;font-weight:600">${runtimeCatalog.model_count || 0}</div><div style="font-size:0.72rem;color:var(--text-secondary)">Runtime models</div></div>
        <div style=${cardStyle}><div style="font-size:1.05rem;font-weight:600">${executableCatalog.model_count || 0}</div><div style="font-size:0.72rem;color:var(--text-secondary)">Child CLI models</div></div>
        <div style=${cardStyle}><div style="font-size:1.05rem;font-weight:600">${executableCatalog.candidate_count || 0}</div><div style="font-size:0.72rem;color:var(--text-secondary)">Eligible candidates</div></div>
        <div style=${cardStyle}><div style="font-size:1.05rem;font-weight:600">${runtimeOnlyModels.length}</div><div style="font-size:0.72rem;color:var(--text-secondary)">Runtime-only</div></div>
        <div style=${cardStyle}><div style="font-size:1.05rem;font-weight:600">${unclassifiedModels.length}</div><div style="font-size:0.72rem;color:var(--text-secondary)">Unclassified CLI</div></div>
      </div>
      <div style=${{ fontSize: "0.76rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
        <div>Current: <code>${runtimeCatalog.current_model || "not captured"}</code>${runtimeCatalog.current_classification?.tier ? ` · T${runtimeCatalog.current_classification.tier} · ${runtimeCatalog.current_classification.rule}` : " · unclassified"}</div>
        <div>Executable cache: ${formatAge(cache.refreshed_at)} · refreshed ${formatTimestamp(cache.refreshed_at)} · ${cache.stale ? "stale/retrying" : "fresh"}</div>
        ${cli && html`<div>CLI: <code>${cli}</code></div>`}
        ${discoveryError && html`<div style=${{ color: "var(--danger-color)" }}>Last refresh error: ${discoveryError} (last known-good catalog retained)</div>`}
      </div>

      <h4 style=${H}>Searchable providers</h4>
      <div style=${{ fontSize: "0.78rem", color: "var(--text-secondary)", lineHeight: 1.45, marginBottom: "0.7rem" }}>
        Delegate deterministically classifies exact child-CLI models from checked providers. Runtime-only Piclaw models are diagnostic only and cannot be selected. By default discovered <code>azure-*</code> providers are excluded.
      </div>
      <div style=${{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "0.65rem" }}>
        <input style=${I} type="search" value=${filter} placeholder="Filter providers…" onInput=${(e) => setFilter(e.target.value)} />
        <button type="button" style=${buttonStyle} disabled=${saving} onClick=${() => load(true)}>Refresh</button>
      </div>
      <div style=${{ display: "grid", gap: "0.35rem" }}>
        ${visibleProviders.map((provider) => {
          const mode = resolveProviderMode(provider.provider, enabledSet);
          const radioName = `delegate-provider-mode-${provider.provider}`;
          return html`
            <div key=${provider.provider} style=${S}>
              <div role="radiogroup" aria-label=${`${provider.provider} mode`} style=${{ display: "flex", alignItems: "center", gap: "0.65rem", minWidth: "14.8rem" }}>
                ${["search", "exclude"].map((option) => html`
                  <label key=${option} style=${{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                    <input type="radio" name=${radioName} value=${option} checked=${mode === option} disabled=${saving}
                      onChange=${() => saveProviderMode(provider.provider, option, providers.map((item) => item.provider), enabledSet)} />
                    <span>${option[0].toUpperCase()}${option.slice(1)}</span>
                  </label>`)}
              </div>
              <span style=${{ minWidth: "150px", fontFamily: "var(--font-mono, monospace)", fontSize: "0.82rem" }}>${provider.provider}</span>
              <span style=${{ color: "var(--text-secondary)", fontSize: "0.76rem" }}>${provider.modelCount} models${mode === "exclude" ? (provider.defaultExcluded ? " · default excluded" : " · excluded") : ""}</span>
            </div>`;
        })}
      </div>

      <h4 style=${H}>Excluded model patterns</h4>
      <div style=${{ fontSize: "0.78rem", color: "var(--text-secondary)", marginBottom: "0.45rem" }}>
        Hard model exclusions, one per line or comma-separated. Supports exact ids, substrings, or <code>*</code> wildcards. Matching models are blocked from automatic selection, fallback, and explicit overrides. Effective provider exclusions: ${effectiveExclusions.providers?.join(", ") || "none"}.
      </div>
      <textarea style=${{ ...I, minHeight: "74px", resize: "vertical", fontFamily: "var(--font-mono, monospace)" }} value=${excludedModelsText} disabled=${saving} placeholder="gpt-4o\n*/experimental-*" onInput=${(e) => setExcludedModelsText(e.target.value)} />
      <div style=${{ display: "flex", justifyContent: "flex-end", marginTop: "0.4rem" }}>
        <button type="button" style=${buttonStyle} disabled=${saving} onClick=${saveExcludedModels}>Save exclusions</button>
      </div>

      <h4 style=${H}>Executable delegate candidates</h4>
      <div style=${{ fontSize: "0.78rem", color: "var(--text-secondary)", marginBottom: "0.45rem" }}>
        ${candidates.length} uniquely classified child-CLI models remain after provider and model policy filters.
      </div>
      <div style=${{ maxHeight: "180px", overflow: "auto", border: "1px solid var(--border-color)", borderRadius: "6px" }}>
        ${candidates.slice(0, 80).map((candidate) => html`
          <div key=${candidate.id} title=${candidate.classificationReason} style=${{ display: "grid", gridTemplateColumns: "3rem 1fr", gap: "0.5rem", padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--border-color)", fontSize: "0.76rem" }}>
            <span style="color:var(--text-secondary)">T${candidate.tier}</span>
            <span>
              <code>${candidate.id}</code>
              <span style="color:var(--text-secondary)"> · ${candidate.family} · ${candidate.classificationRule}</span>
              <div style="color:var(--text-secondary);font-size:0.7rem;margin-top:0.15rem">images=${candidate.supportsImages === true ? "yes" : candidate.supportsImages === false ? "no" : "?"} · reasoning=${candidate.reasoning === true ? "yes" : candidate.reasoning === false ? "no" : "?"} · context=${compactTokens(candidate.contextWindow)} · output=${compactTokens(candidate.maxOutputTokens)}</div>
            </span>
          </div>`)}
      </div>

      <h4 style=${H}>Catalog differences and rejections</h4>
      <div style=${{ fontSize: "0.78rem", color: "var(--text-secondary)", marginBottom: "0.45rem" }}>
        Runtime-only models are known to Piclaw but not executable by the child CLI. Rejected CLI models remain executable but are excluded or unclassified.
      </div>
      <div style=${{ maxHeight: "190px", overflow: "auto", border: "1px solid var(--border-color)", borderRadius: "6px" }}>
        ${runtimeOnlyModels.length === 0 && rejectedModels.length === 0 && html`<div style="padding:0.5rem;font-size:0.76rem;color:var(--text-secondary)">No catalog differences or rejected models.</div>`}
        ${runtimeOnlyModels.slice(0, 50).map((model) => html`
          <div key=${`runtime:${model.fullId}`} style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-color);font-size:0.74rem">
            <code>${model.fullId}</code> <span style="color:var(--text-secondary)">runtime-only · ${model.classification?.status === "classified" ? `T${model.classification.tier} ${model.classification.rule}` : model.classification?.reason}</span>
          </div>`)}
        ${rejectedModels.slice(0, 80).map((model) => html`
          <div key=${`rejected:${model.fullId}`} style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-color);font-size:0.74rem">
            <code>${model.fullId}</code> <span style="color:var(--text-secondary)">rejected · ${model.rejection_reason}</span>
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
