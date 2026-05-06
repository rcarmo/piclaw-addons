/**
 * late-night-regrets/index.ts — Nightly interaction quality reflection add-on.
 *
 * Registers:
 * - /regrets command to manually trigger a reflection pass
 * - A skill for the nightly scheduled task
 * - Settings pane for configuring schedule and thresholds
 */

import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";

const EXTENSION_ID = "late-night-regrets";
const baseDir = dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────

export interface RegretsConfig {
  enabled: boolean;
  cron_schedule: string;
  confidence_threshold: number;
  reflections_path: string;
  exports_dir: string;
  recent_hours_for_reflection: number;
}

const DEFAULT_CONFIG: RegretsConfig = {
  enabled: true,
  cron_schedule: "30 2 * * *",
  confidence_threshold: 0.55,
  reflections_path: "notes/memory/interaction-reflections.md",
  exports_dir: "exports/interaction-quality",
  recent_hours_for_reflection: 24,
};

let kvStore: ExtensionStorage | null = null;

function kv(): ExtensionStorage {
  if (!kvStore) kvStore = createExtensionStorage(EXTENSION_ID);
  return kvStore;
}

function loadConfig(): RegretsConfig {
  try {
    const saved = kv().get<Partial<RegretsConfig>>("config", "global");
    if (saved) {
      return {
        enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULT_CONFIG.enabled,
        cron_schedule: typeof saved.cron_schedule === "string" && saved.cron_schedule.trim() ? saved.cron_schedule.trim() : DEFAULT_CONFIG.cron_schedule,
        confidence_threshold: typeof saved.confidence_threshold === "number" ? Math.max(0.1, Math.min(1, saved.confidence_threshold)) : DEFAULT_CONFIG.confidence_threshold,
        reflections_path: typeof saved.reflections_path === "string" && saved.reflections_path.trim() ? saved.reflections_path.trim() : DEFAULT_CONFIG.reflections_path,
        exports_dir: typeof saved.exports_dir === "string" && saved.exports_dir.trim() ? saved.exports_dir.trim() : DEFAULT_CONFIG.exports_dir,
        recent_hours_for_reflection: typeof saved.recent_hours_for_reflection === "number" ? Math.max(1, Math.round(saved.recent_hours_for_reflection)) : DEFAULT_CONFIG.recent_hours_for_reflection,
      };
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: RegretsConfig): RegretsConfig {
  kv().set("config", config, "global");
  return config;
}

// ── Training & classification ────────────────────────────────────────

export function getTrainScriptPath(): string {
  return join(baseDir, "scripts", "train-interaction-quality-bayes.ts");
}

export function getAttentionFilePath(config: RegretsConfig): string {
  const workspace = process.env.PICLAW_WORKSPACE || "/workspace";
  return join(workspace, config.exports_dir, "interaction-quality-attention-latest.jsonl");
}

export function getReportFilePath(config: RegretsConfig): string {
  const workspace = process.env.PICLAW_WORKSPACE || "/workspace";
  return join(workspace, config.exports_dir, "interaction-quality-report-latest.md");
}

export function getReflectionsFilePath(config: RegretsConfig): string {
  const workspace = process.env.PICLAW_WORKSPACE || "/workspace";
  return join(workspace, config.reflections_path);
}

// ── Settings API ─────────────────────────────────────────────────────

function handleGetConfig(): RegretsConfig {
  return loadConfig();
}

function handleSetConfig(body: Partial<RegretsConfig>): { ok: boolean; config: RegretsConfig } {
  const current = loadConfig();
  const next: RegretsConfig = {
    enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
    cron_schedule: typeof body.cron_schedule === "string" && body.cron_schedule.trim() ? body.cron_schedule.trim() : current.cron_schedule,
    confidence_threshold: typeof body.confidence_threshold === "number" ? Math.max(0.1, Math.min(1, body.confidence_threshold)) : current.confidence_threshold,
    reflections_path: typeof body.reflections_path === "string" && body.reflections_path.trim() ? body.reflections_path.trim() : current.reflections_path,
    exports_dir: typeof body.exports_dir === "string" && body.exports_dir.trim() ? body.exports_dir.trim() : current.exports_dir,
    recent_hours_for_reflection: typeof body.recent_hours_for_reflection === "number" ? Math.max(1, Math.round(body.recent_hours_for_reflection)) : current.recent_hours_for_reflection,
  };
  saveConfig(next);
  return { ok: true, config: next };
}

type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: {
    get?: (payload: unknown, req: Request) => unknown | Promise<unknown>;
    set?: (payload: unknown, req: Request) => unknown | Promise<unknown>;
  },
  extensionPath?: string,
) => "created" | "updated";

const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
if (typeof registerAddonConfigApi === "function") {
  registerAddonConfigApi(EXTENSION_ID, "config", {
    get: async () => handleGetConfig(),
    set: async (payload) => handleSetConfig((payload && typeof payload === "object" ? payload : {}) as Partial<RegretsConfig>),
  }, import.meta.dir);
}

// ── Extension entry point ────────────────────────────────────────────

export default function lateNightRegretsExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "skills", "late-night-regrets", "SKILL.md")],
  }));

  pi.registerCommand("regrets", {
    description: "Manually trigger an interaction quality reflection pass",
    handler: async (_args, ctx) => {
      const config = loadConfig();
      if (!config.enabled) {
        ctx.ui.notify("Late Night Regrets is disabled in settings.", "warning");
        return;
      }
      ctx.ui.setWorking("Running interaction quality classifier…");
      ctx.ui.notify("Running Late Night Regrets classifier and reflection…", "info");
    },
  });

  pi.on("before_agent_start", async (event) => {
    const config = loadConfig();
    if (!config.enabled) return { systemPrompt: event.systemPrompt };
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Late Night Regrets\nInteraction quality classifier active. Reflections: \`${config.reflections_path}\`. Nightly at ${config.cron_schedule} UTC.`,
    };
  });
}
