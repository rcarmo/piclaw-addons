import { lateNightRegretsIcon } from './icon.ts';
import { settingsFieldStyles } from './settings-fields.ts';

type ModelOption = { id: string; name: string };
interface Config {
  enabled: boolean;
  decision_model: string;
  review_budget_tokens: number;
  recent_hours_for_reflection: number;
  review_scope: "current" | "all";
}
type Setter<T> = (value: T) => void;
interface Runtime {
  html: (strings: TemplateStringsArray, ...values: any[]) => any;
  useState: <T>(value: T) => [T, Setter<T>];
  useEffect: (fn: () => void | (() => void), deps: unknown[]) => void;
}
const globals = globalThis as typeof globalThis & {
  __piclawPreactHtm?: Runtime;
  __piclawPreact?: Runtime;
  __piclawSettingsPaneRegistry?: {
    registerSettingsPane: (pane: unknown) => void;
    notifySettingsPanesChanged?: () => void;
  };
};
const runtime = globals.__piclawPreactHtm || globals.__piclawPreact;
const API = "/agent/addons/api/late-night-regrets";
export async function request(action: string, patch?: Partial<Config>) {
  const response = await fetch(
    `${API}/${action}`,
    patch
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }
      : undefined,
  );
  const data = await response.json();
  if (!response.ok || data.ok !== true)
    throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
export function RegretsSettings() {
  if (!runtime) return null;
  const { html, useState, useEffect } = runtime;
  const [config, setConfig] = useState<Config | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.all([request("config"), request("models")])
      .then(([c, m]) => {
        if (alive) {
          setConfig(c.config);
          setModels(m.models);
        }
      })
      .catch(() => {
        if (alive)
          setMessage("Could not load settings. Reopen this pane to retry.");
      });
    return () => {
      alive = false;
    };
  }, []);
  const save = async (patch: Partial<Config>) => {
    setSaving(true);
    setMessage("");
    try {
      setConfig((await request("config", patch)).config);
      setMessage("Saved");
    } catch {
      setMessage("Save failed. Your previous settings are unchanged.");
    } finally {
      setSaving(false);
    }
  };
  if (!config) return html`<p class=${message ? "settings-addon-error" : "settings-addon-status"} role="status">${message || "Loading…"}</p>`;
  return html`<section
    data-settings-addon="late-night-regrets"
    class="settings-addon-section"
  >
    <style>${settingsFieldStyles}</style>
    <h3 class="settings-addon-heading">Late Night Regrets</h3>
    <p class="settings-addon-help">
      Review all human exchanges when they fit. On busy days, use Bayes ordering
      plus a sample from the remainder. Short messages stay eligible.
    </p>
    <label class="settings-addon-check"
      ><input
        type="checkbox"
        checked=${config.enabled}
        disabled=${saving}
        onChange=${(e: Event) => void save({ enabled: (e.target as HTMLInputElement).checked })}
      />
      Enable reflection</label
    >
    <label class="settings-addon-field"
      ><span class="settings-addon-label">Review scope</span>
      <select
        class="settings-addon-control"
        aria-label="Review scope"
        value=${config.review_scope}
        disabled=${saving}
        onChange=${(e: Event) => void save({ review_scope: (e.target as HTMLSelectElement).value as "current" | "all" })}
      >
        <option value="all">All chats (single-user instance)</option>
        <option value="current">Current chat only</option>
      </select>
    </label>
    <label class="settings-addon-field"
      ><span class="settings-addon-label">Review budget (estimated input tokens)</span>
      <input
        class="settings-addon-control"
        aria-label="Review budget"
        type="number"
        min="512"
        max="100000"
        value=${config.review_budget_tokens}
        disabled=${saving}
        onBlur=${(e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (v >= 512 && v <= 100000 && v !== config.review_budget_tokens)
            void save({ review_budget_tokens: v });
        }}
      />
    </label>
    <p class="settings-addon-help">
      This bounds the input packet, not billed tokens or later context lookups.
    </p>
    <label class="settings-addon-field"
      ><span class="settings-addon-label">Decision model (optional)</span>
      <select
        class="settings-addon-control"
        aria-label="Decision model"
        value=${config.decision_model}
        disabled=${saving}
        onChange=${(e: Event) => void save({ decision_model: (e.target as HTMLSelectElement).value })}
      >
        <option value="">Off — nightly reviewer only</option>
        ${config.decision_model && !models.some((m) => m.id === config.decision_model) ? html`<option value=${config.decision_model} disabled>${config.decision_model} (unavailable)</option>` : null}
        ${models.map((m) => html`<option value=${m.id}>${m.name} — ${m.id}</option>`)}
      </select>
    </label>
    <p class="settings-addon-help">
      Selecting a model permits one bounded call per review using your
      configured provider. It receives the same redacted excerpts and suggests
      review, routine or uncertain. It cannot write notes. Failed calls fall
      back to the nightly reviewer; no model is substituted.
    </p>
    <p class="settings-addon-help">
      Window: ${config.recent_hours_for_reflection} hours. Existing scheduled
      tasks must use the new reflection prompt; saving these settings does not
      create or reschedule tasks.
    </p>
    <p class=${/fail/i.test(message) ? "settings-addon-error" : "settings-addon-status"} role="status">${message}</p>
  </section>`;
}
let registered = false;
function register() {
  if (registered || !runtime || !globals.__piclawSettingsPaneRegistry) return;
  globals.__piclawSettingsPaneRegistry.registerSettingsPane({
    id: "late-night-regrets",
    label: "Late Night Regrets",
    icon: lateNightRegretsIcon,
    order: 70,
    searchable: true,
    component: RegretsSettings,
  });
  globals.__piclawSettingsPaneRegistry.notifySettingsPanesChanged?.();
  registered = true;
}
register();
queueMicrotask(register);
globalThis.addEventListener?.("piclaw:addons-loaded", register);
