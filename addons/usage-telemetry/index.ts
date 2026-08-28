import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";
import { DEFAULT_CONFIG, exportUsage, instanceId, type UsageTelemetryConfig } from "./usage.js";

const ADDON_ID = "usage-telemetry";
const baseDir = dirname(fileURLToPath(import.meta.url));
let storage: ExtensionStorage | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function kv(): ExtensionStorage { return storage ||= createExtensionStorage(ADDON_ID); }
function loadConfig(): UsageTelemetryConfig {
  try { return { ...DEFAULT_CONFIG, ...(kv().get<Partial<UsageTelemetryConfig>>("config", "global") || {}) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(config: UsageTelemetryConfig): void { kv().set("config", config, "global"); }

function normalize(body: Partial<UsageTelemetryConfig>): UsageTelemetryConfig {
  const current = loadConfig();
  return {
    enabled: body.enabled ?? current.enabled,
    carbon_host: typeof body.carbon_host === "string" ? body.carbon_host.trim() : current.carbon_host,
    carbon_port: Number.isInteger(body.carbon_port) && body.carbon_port! > 0 && body.carbon_port! < 65536 ? body.carbon_port! : current.carbon_port,
    graphite_prefix: typeof body.graphite_prefix === "string" && body.graphite_prefix.trim() ? body.graphite_prefix.trim() : current.graphite_prefix,
    instance_id: typeof body.instance_id === "string" ? body.instance_id.trim() : current.instance_id,
    interval_minutes: Number.isInteger(body.interval_minutes) ? Math.max(1, Math.min(60, body.interval_minutes!)) : current.interval_minutes,
    graphite_render_url: typeof body.graphite_render_url === "string" ? body.graphite_render_url.trim().replace(/\/$/, "") : current.graphite_render_url,
  };
}

function schedule(): void {
  if (timer) { clearInterval(timer); timer = null; }
  const config = loadConfig();
  if (!config.enabled || !config.carbon_host) return;
  const run = async () => {
    if (running) return;
    running = true;
    try { await exportUsage(loadConfig()); } catch (error) { console.warn("[usage-telemetry] Carbon export failed; retained in spool", error); }
    finally { running = false; }
  };
  void run();
  timer = setInterval(() => void run(), config.interval_minutes * 60_000);
}

type ConfigRegistrar = (addonId: string, action: string, handlers: { get?: () => unknown | Promise<unknown>; set?: (payload: unknown) => unknown | Promise<unknown> }, extensionPath?: string) => unknown;
const registrar = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as ConfigRegistrar | undefined;
if (typeof registrar === "function") {
  registrar(ADDON_ID, "config", {
    get: () => loadConfig(),
    set: (payload) => { const config = normalize((payload && typeof payload === "object" ? payload : {}) as Partial<UsageTelemetryConfig>); saveConfig(config); schedule(); return { ok: true, config }; },
  }, import.meta.dir);
}

export default function usageTelemetry(pi: ExtensionAPI): void {
  schedule();
  pi.on("session_start", async () => { schedule(); });
  pi.on("resources_discover", () => ({ skillPaths: [join(baseDir, "skills", "usage-telemetry-chart", "SKILL.md")] }));
  pi.registerTool({
    name: "usage_telemetry_status", label: "usage_telemetry_status", description: "Shows Graphite usage telemetry export configuration and identity.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const config = loadConfig();
      return { content: [{ type: "text", text: `Usage telemetry is ${config.enabled && config.carbon_host ? "enabled" : "disabled"}.\nInstance: ${instanceId(config)}\nCarbon: ${config.carbon_host ? `${config.carbon_host}:${config.carbon_port}` : "not configured"}` }], details: config };
    },
  });
}
