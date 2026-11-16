import { settingsFieldStyles } from "./settings-fields.ts";
import type {
  CanonicalModelRef,
  CheapskateCandidateDto,
  CheapskateConfigPatch,
  CheapskateStatusDto,
} from "../shared.js";

type HtmlTag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
type StateSetter<T> = (value: T | ((current: T) => T)) => void;
type PreactRuntime = {
  html?: HtmlTag;
  useState?: <T>(initial: T) => [T, StateSetter<T>];
  useEffect?: (effect: () => void | (() => void), dependencies: unknown[]) => void;
  useCallback?: <T extends (...args: any[]) => any>(callback: T, dependencies: unknown[]) => T;
};

type SettingsPaneRegistry = {
  registerSettingsPane?: (pane: { id: string; label: string; icon: unknown; order: number; searchable: boolean; component: () => unknown }) => void;
  notifySettingsPanesChanged?: () => void;
};

type WebGlobals = typeof globalThis & {
  __piclawPreactHtm?: PreactRuntime;
  __piclawPreact?: PreactRuntime;
  __piclawSettingsPaneRegistry?: SettingsPaneRegistry;
};

const globals = globalThis as WebGlobals;
const preact = globals.__piclawPreactHtm || globals.__piclawPreact || {};
const html = preact.html;
const useState = preact.useState;
const useEffect = preact.useEffect;
const useCallback = preact.useCallback;
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);
const API = "/agent/addons/api/cheapskate/config";

function chatJid(): string {
  try {
    const value = new URL(globalThis.location?.href || "http://localhost/").searchParams.get("chat_jid");
    return value?.trim() || "web:default";
  } catch {
    return "web:default";
  }
}

async function requestStatus(patch?: CheapskateConfigPatch): Promise<CheapskateStatusDto> {
  const response = await fetch(`${API}?chat_jid=${encodeURIComponent(chatJid())}`, patch ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  } : undefined);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${response.status}`);
  return body as CheapskateStatusDto;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function includesQuery(candidate: CheapskateCandidateDto, query: string, provider: string): boolean {
  if (provider && candidate.provider !== provider) return false;
  if (!query) return true;
  const text = `${candidate.ref} ${candidate.provider_name} ${candidate.name}`.toLowerCase();
  return text.includes(query.toLowerCase());
}

function stateLabel(candidate: CheapskateCandidateDto): string {
  const labels: Record<CheapskateCandidateDto["state"], string> = {
    eligible: "Eligible now",
    needs_credentials: "Needs credentials",
    disabled: "Disabled",
    excluded_by_scope: "Excluded by session scope",
    unhealthy: candidate.health.state === "cost_violation" ? "Cost violation" : "Temporarily unhealthy",
  };
  return labels[candidate.state];
}

/** Semantic tone for a candidate state; colours come from the host theme. */
function stateTone(candidate: CheapskateCandidateDto): string | undefined {
  if (candidate.state === "eligible") return "success";
  if (candidate.state === "needs_credentials" || candidate.state === "excluded_by_scope") return "warning";
  if (candidate.state === "unhealthy") return "danger";
  return undefined;
}

function CheapskateSettings(): unknown {
  if (!HAS_RUNTIME || !html || !useState || !useEffect || !useCallback) return null;
  const [status, setStatus] = useState<CheapskateStatusDto | null>(null);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      setStatus(await requestStatus());
      setMessage("");
    } catch (error) {
      setMessage(`Failed to load Cheapskate: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (patch: CheapskateConfigPatch) => {
    setSaving(true);
    setMessage("");
    try {
      setStatus(await requestStatus(patch));
      setMessage("Saved");
      setTimeout(() => setMessage(""), 2_000);
    } catch (error) {
      setMessage(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }, []);

  if (!status) return html`<p class="settings-addon-status" role="status">${message || "Loading…"}</p>`;
  const providers = [...new Map(status.candidates.map((candidate) => [candidate.provider, candidate.provider_name])).entries()];
  const visible = status.candidates.filter((candidate) => includesQuery(candidate, query, providerFilter));
  const orderedRefs = status.config.priority.filter((ref) => status.candidates.some((candidate) => candidate.ref === ref));
  const enabledUnordered = status.candidates.filter((candidate) => candidate.model_enabled && !orderedRefs.includes(candidate.ref)).map((candidate) => candidate.ref);
  const currentOrder = [...orderedRefs, ...enabledUnordered];
  const move = (candidate: CheapskateCandidateDto, delta: number) => {
    const order = currentOrder.includes(candidate.ref) ? [...currentOrder] : [...currentOrder, candidate.ref];
    const index = order.indexOf(candidate.ref);
    const target = Math.max(0, Math.min(order.length - 1, index + delta));
    order.splice(index, 1);
    order.splice(target, 0, candidate.ref);
    void save({ priority: order });
  };

  const groups = ["eligible", "needs_credentials", "disabled", "excluded_by_scope", "unhealthy"] as const;

  return html`<div class="settings-addon-section" data-testid="cheapskate-settings" data-settings-addon="cheapskate">
    <style>${settingsFieldStyles}</style>
    <div class="settings-addon-control-group">
      <label class="settings-addon-check">
        <input type="checkbox" checked=${status.config.enabled} disabled=${saving} onChange=${(event: Event) => void save({ enabled: (event.target as HTMLInputElement).checked })} />
        <strong>Enable Cheapskate</strong>
      </label>
      <span class="settings-addon-badge" data-tone=${status.virtual_model_registered ? "success" : "warning"}>
        ${status.virtual_model_registered ? "cheapskate/auto registered" : "virtual model unavailable"}
      </span>
      ${status.active_ref ? html`<code class="settings-addon-help settings-addon-mono">active: ${status.active_ref}</code>` : null}
    </div>

    <p class="settings-addon-help">
      Only effective catalogue models with exact zero base and tiered token prices are selectable. Paid and unknown-cost models are excluded before this pane is rendered.
    </p>
    ${status.empty_reason ? html`<div class="settings-addon-callout" data-tone="warning" role="status">${status.empty_reason}</div>` : null}

    ${providers.length ? html`<div class="settings-addon-actions cheapskate-providers" role="group" aria-label="Zero-cost providers">
      ${providers.map(([id, name]) => {
        const enabled = status.config.providers[id]?.enabled !== false;
        return html`<label class="settings-addon-check">
          <input aria-label=${`Enable provider ${id}`} type="checkbox" checked=${enabled} disabled=${saving}
            onChange=${(event: Event) => void save({ providers: { [id]: { enabled: (event.target as HTMLInputElement).checked } } })} />
          ${name}
        </label>`;
      })}
    </div>` : null}

    <div class="settings-addon-actions cheapskate-filters">
      <label class="settings-addon-field"><span class="settings-addon-label">Filter free models</span><input class="settings-addon-control" aria-label="Filter free models" type="search" value=${query} placeholder="Filter free models" onInput=${(event: Event) => setQuery((event.target as HTMLInputElement).value)} /></label>
      <label class="settings-addon-field"><span class="settings-addon-label">Filter provider</span><select class="settings-addon-control" aria-label="Filter provider" value=${providerFilter} onChange=${(event: Event) => setProviderFilter((event.target as HTMLSelectElement).value)}>
        <option value="">All zero-cost providers</option>
        ${providers.map(([id, name]) => html`<option value=${id}>${name}</option>`)}
      </select></label>
    </div>

    ${groups.map((group) => {
      const rows = visible.filter((candidate) => candidate.state === group);
      if (rows.length === 0) return null;
      return html`<section data-state=${group}>
        <h4 class="settings-addon-heading">${stateLabel(rows[0])} (${rows.length})</h4>
        ${rows.map((candidate) => {
          const enabled = candidate.model_enabled;
          const canEnable = candidate.configured && candidate.in_scope && candidate.health.state !== "cost_violation";
          const position = currentOrder.indexOf(candidate.ref);
          return html`<div class="cheapskate-candidate" data-model-ref=${candidate.ref}>
            <div class="cheapskate-candidate-head">
              <input aria-label=${`Enable ${candidate.ref}`} type="checkbox" checked=${enabled} disabled=${saving || (!enabled && !canEnable)} onChange=${(event: Event) => void save({ models: { [candidate.ref]: { enabled: (event.target as HTMLInputElement).checked } } })} />
              <strong>${candidate.name}</strong>
              <code class="settings-addon-mono">${candidate.ref}</code>
              <span class="settings-addon-badge cheapskate-state" data-tone=${stateTone(candidate)}>${stateLabel(candidate)}</span>
            </div>
            <div class="settings-addon-help cheapskate-facts">
              <span>context ${formatTokens(candidate.context_window)}</span>
              <span>output ${formatTokens(candidate.max_tokens)}</span>
              <span>${candidate.reasoning ? "reasoning" : "no reasoning"}</span>
              <span>${candidate.inputs.join(" + ")}</span>
              ${candidate.health.cooldown_until ? html`<span>retry after ${candidate.health.cooldown_until}</span>` : null}
              ${candidate.health.last_error ? html`<span title=${candidate.health.last_error}>${candidate.health.last_error}</span>` : null}
            </div>
            ${enabled ? html`<div class="settings-addon-actions">
              <span class="settings-addon-help">priority ${position >= 0 ? position + 1 : "unranked"}</span>
              <button type="button" aria-label=${`Raise priority ${candidate.ref}`} disabled=${saving || position <= 0} onClick=${() => move(candidate, -1)}>↑</button>
              <button type="button" aria-label=${`Lower priority ${candidate.ref}`} disabled=${saving || position < 0 || position >= currentOrder.length - 1} onClick=${() => move(candidate, 1)}>↓</button>
            </div>` : null}
          </div>`;
        })}
      </section>`;
    })}

    ${visible.length === 0 ? html`<p class="settings-addon-status">No zero-cost catalogue models match this filter.</p>` : null}
    <p class="settings-addon-help">
      Excluded from selection: ${status.excluded_costs.positive} positive-price, ${status.excluded_costs.unknown_or_malformed} unknown/malformed-cost and ${status.excluded_costs.recursive} recursive model entries.
    </p>
    ${message ? (message.startsWith("Save failed") || message.startsWith("Failed")
      ? html`<p class="settings-addon-error" role="alert">${message}</p>`
      : html`<p class="settings-addon-status" role="status">${message}</p>`) : null}
  </div>`;
}

const ICON = html ? html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M12 6v5"/><path d="M12 14h.01"/></svg>` : null;
let registered = false;

function registerPane(): boolean {
  if (!HAS_RUNTIME || registered) return registered;
  const registry = globals.__piclawSettingsPaneRegistry;
  if (!registry?.registerSettingsPane) return false;
  registry.registerSettingsPane({ id: "cheapskate", label: "Cheapskate", icon: ICON, order: 35, searchable: false, component: CheapskateSettings });
  registry.notifySettingsPanesChanged?.();
  registered = true;
  return true;
}

function scheduleRegistration(): void {
  const attempt = () => { try { registerPane(); } catch {} };
  attempt();
  queueMicrotask(attempt);
  setTimeout(attempt, 0);
  setTimeout(attempt, 250);
  globalThis.addEventListener?.("piclaw:addons-loaded", attempt);
}

scheduleRegistration();

export { CheapskateSettings, includesQuery, requestStatus, stateLabel };
