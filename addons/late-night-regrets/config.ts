import { createExtensionStorage } from "./compat/extension-kv.js";

export interface RegretsConfig {
  enabled: boolean;
  cron_schedule: string;
  confidence_threshold: number; // legacy classifier CLI only
  reflections_path: string;
  exports_dir: string;
  recent_hours_for_reflection: number;
  review_budget_tokens: number;
  decision_model: string; // empty: no extra call
  review_scope: "current" | "all";
}
export const DEFAULT_CONFIG: RegretsConfig = {
  enabled: true,
  cron_schedule: "30 2 * * *",
  confidence_threshold: 0.55,
  reflections_path: "notes/memory/interaction-reflections.md",
  exports_dir: "exports/interaction-quality",
  recent_hours_for_reflection: 24,
  review_budget_tokens: 24000,
  decision_model: "",
  review_scope: "all",
};
let storage: ReturnType<typeof createExtensionStorage> | undefined;
const kv = () => (storage ||= createExtensionStorage("late-night-regrets"));
export function normaliseConfig(
  body: Partial<RegretsConfig>,
  current = DEFAULT_CONFIG,
): RegretsConfig {
  const next = { ...current };
  if (typeof body.enabled === "boolean") next.enabled = body.enabled;
  if (body.review_scope === "current" || body.review_scope === "all")
    next.review_scope = body.review_scope;
  for (const key of [
    "cron_schedule",
    "reflections_path",
    "exports_dir",
  ] as const) {
    if (typeof body[key] === "string" && body[key]!.trim())
      next[key] = body[key]!.trim();
  }
  for (const [key, min, max] of [
    ["recent_hours_for_reflection", 1, 168],
    ["review_budget_tokens", 512, 100000],
    ["confidence_threshold", 0.1, 1],
  ] as const) {
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value))
      next[key] = Math.max(
        min,
        Math.min(
          max,
          key === "confidence_threshold" ? value : Math.round(value),
        ),
      );
  }
  if (typeof body.decision_model === "string")
    next.decision_model = body.decision_model.trim();
  return next;
}
export function loadConfig(): RegretsConfig {
  return normaliseConfig(
    kv().get<Partial<RegretsConfig>>("config", "global") || {},
  );
}
export function saveConfig(patch: Partial<RegretsConfig>): RegretsConfig {
  const next = normaliseConfig(patch, loadConfig());
  kv().set("config", next, "global");
  return next;
}
