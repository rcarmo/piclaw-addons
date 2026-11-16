// @ts-nocheck
import { settingsStyles } from "./styles.ts";
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
  const [cliVersion, setCliVersion] = useState("");
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
      setCliVersion(payload.cli_package_version || "");
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

  if (!config) return html`<div class="delegate-settings"><style>${settingsStyles}</style><p class="settings-addon-status" role="status">Loading delegate settings…</p></div>`;

  const enabledSet = new Set(Array.isArray(config.searchable_providers)
    ? config.searchable_providers
    : providers.filter((provider) => provider.enabled).map((provider) => provider.provider));
  const excludedSet = new Set(Array.isArray(config.excluded_providers)
    ? config.excluded_providers
    : providers.filter((provider) => provider.excluded).map((provider) => provider.provider));
  const q = filter.trim().toLowerCase();
  const visibleProviders = providers.filter((provider) => !q || provider.provider.toLowerCase().includes(q));

  return html`
    <div class="delegate-settings">
      <style>${settingsStyles}</style>
      <section class="settings-addon-section">
      <h4>Catalog status</h4>
      <div class="delegate-metrics">
        <div class="delegate-metric"><div class="delegate-metric-count">${runtimeCatalog.model_count || 0}</div><div class="settings-addon-help">Runtime models</div></div>
        <div class="delegate-metric"><div class="delegate-metric-count">${executableCatalog.model_count || 0}</div><div class="settings-addon-help">Child CLI models</div></div>
        <div class="delegate-metric"><div class="delegate-metric-count">${executableCatalog.candidate_count || 0}</div><div class="settings-addon-help">Approved models</div></div>
        <div class="delegate-metric"><div class="delegate-metric-count">${runtimeOnlyModels.length}</div><div class="settings-addon-help">Runtime-only</div></div>
        <div class="delegate-metric"><div class="delegate-metric-count">${unclassifiedModels.length}</div><div class="settings-addon-help">Unclassified CLI</div></div>
      </div>
      <div class="settings-addon-help">
        <div>Current: <code>${runtimeCatalog.current_model || "not captured"}</code>${runtimeCatalog.current_classification?.tier ? ` · T${runtimeCatalog.current_classification.tier} · ${runtimeCatalog.current_classification.rule}` : " · unclassified"}</div>
        <div>Executable cache: ${formatAge(cache.refreshed_at)} · refreshed ${formatTimestamp(cache.refreshed_at)} · ${cache.stale ? "stale/retrying" : "fresh"}</div>
        ${cli && html`<div>CLI: <code>${cli}</code> · Pi package: ${cliVersion || "unknown (override or PATH command)"}</div>`}
        ${discoveryError && html`<div class="settings-addon-error" role="alert">Last refresh error: ${discoveryError} (${executableCatalog.model_count ? "last known-good catalog retained for this CLI" : "no executable catalog for this CLI"})</div>`}
      </div>
      </section>

      <section class="settings-addon-section">
      <h4>Approved providers</h4>
      <p class="settings-addon-help" id="delegate-provider-help">
        No provider is approved by default. Delegate can launch models only from providers marked <strong>Approved</strong>. Runtime-only Piclaw models are diagnostic only and cannot be selected.
      </p>
      <div class="settings-addon-field">
        <label class="settings-addon-label" for="delegate-provider-filter">Filter providers</label>
        <div class="settings-addon-control-group">
        <input id="delegate-provider-filter" class="settings-addon-control" aria-describedby="delegate-provider-help" type="search" value=${filter} placeholder="Filter providers…" onInput=${(e) => setFilter(e.target.value)} />
        <button type="button" disabled=${saving} onClick=${() => load(true)}>Refresh</button>
        </div>
      </div>
      <div>
        ${visibleProviders.map((provider) => {
          const mode = resolveProviderMode(provider.provider, enabledSet);
          const radioName = `delegate-provider-mode-${provider.provider}`;
          return html`
            <div key=${provider.provider} class="delegate-provider-row">
              <div role="radiogroup" aria-label=${`${provider.provider} mode`} class="settings-addon-control-group">
                ${["approved", "exclude"].map((option) => html`
                  <label key=${option} class="delegate-radio settings-addon-label">
                    <input type="radio" name=${radioName} value=${option} checked=${mode === (option === "approved" ? "search" : option)} disabled=${saving}
                      onChange=${() => saveProviderMode(provider.provider, option === "approved" ? "search" : option, providers.map((item) => item.provider), enabledSet)} />
                    <span>${option[0].toUpperCase()}${option.slice(1)}</span>
                  </label>`)}
              </div>
              <span class="delegate-provider-name">${provider.provider}</span>
              <span class="settings-addon-help">${provider.modelCount} models${mode === "exclude" ? (provider.defaultExcluded ? " · default excluded" : " · excluded") : ""}</span>
            </div>`;
        })}
      </div>
      </section>

      <section class="settings-addon-section">
      <h4>Excluded model patterns</h4>
      <div class="settings-addon-field">
      <label class="settings-addon-label" for="delegate-exclusions">Excluded model patterns</label>
      <p class="settings-addon-help" id="delegate-exclusions-help">
        Hard model exclusions, one per line or comma-separated. Supports exact ids, substrings, or <code>*</code> wildcards. Matching models are blocked from automatic selection, fallback, and explicit model selection. Effective provider exclusions: ${effectiveExclusions.providers?.join(", ") || "none"}.
      </p>
      <textarea id="delegate-exclusions" class="settings-addon-control" aria-describedby="delegate-exclusions-help" style="min-height:74px;font-family:var(--font-mono, monospace)" value=${excludedModelsText} disabled=${saving} placeholder="gpt-4o\n*/experimental-*" onInput=${(e) => setExcludedModelsText(e.target.value)} />
      </div>
      <div class="settings-addon-actions">
        <button type="button" disabled=${saving} onClick=${saveExcludedModels}>Save exclusions</button>
      </div>
      </section>

      <section class="settings-addon-section">
      <h4>Approved delegate models</h4>
      <p class="settings-addon-help">
        Delegate can launch only these ${candidates.length} models, whether selected automatically, requested explicitly by an agent, or used as a fallback. Each model is from an approved provider, matches the ordered model policy, exists in the child CLI catalog, and does not match an exclusion.
      </p>
      <div class="delegate-scroll" style="max-height:180px">
        ${candidates.slice(0, 80).map((candidate) => html`
          <div key=${candidate.id} title=${candidate.classificationReason} class="delegate-candidate">
            <span class="settings-addon-help">T${candidate.tier}</span>
            <span>
              <code>${candidate.id}</code>
              <span class="settings-addon-help"> · ${candidate.family} · ${candidate.classificationRule}</span>
              <div class="settings-addon-help">images=${candidate.supportsImages === true ? "yes" : candidate.supportsImages === false ? "no" : "?"} · reasoning=${candidate.reasoning === true ? "yes" : candidate.reasoning === false ? "no" : "?"} · context=${compactTokens(candidate.contextWindow)} · output=${compactTokens(candidate.maxOutputTokens)}</div>
            </span>
          </div>`)}
      </div>
      </section>

      <section class="settings-addon-section">
      <h4>Catalog differences and rejections</h4>
      <p class="settings-addon-help">
        Runtime-only models are known to Piclaw but not executable by the child CLI. Rejected CLI models cannot be used by Delegate because their provider is unapproved, the model is excluded, or the model is unclassified.
      </p>
      <div class="delegate-scroll" style="max-height:190px">
        ${runtimeOnlyModels.length === 0 && rejectedModels.length === 0 && html`<p class="settings-addon-help">No catalog differences or rejected models.</p>`}
        ${runtimeOnlyModels.slice(0, 50).map((model) => html`
          <div key=${`runtime:${model.fullId}`} class="delegate-rejection settings-addon-help">
            <code>${model.fullId}</code> <span>runtime-only · ${model.classification?.status === "classified" ? `T${model.classification.tier} ${model.classification.rule}` : model.classification?.reason}</span>
          </div>`)}
        ${rejectedModels.slice(0, 80).map((model) => html`
          <div key=${`rejected:${model.fullId}`} class="delegate-rejection settings-addon-help">
            <code>${model.fullId}</code> <span>rejected · ${model.rejection_reason}</span>
          </div>`)}
      </div>
      </section>
      ${message && html`<div class=${/failed|error/i.test(message) ? "settings-addon-error" : "settings-addon-status"} role=${/failed|error/i.test(message) ? "alert" : "status"}>${message}</div>`}
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
