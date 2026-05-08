/**
 * piclaw-addon-observability — OpenTelemetry tracing for piclaw instances.
 *
 * Uses @azure/monitor-opentelemetry (the official Azure Monitor distro) for:
 *   - Trace export to Application Insights
 *   - Live Metrics Stream (QuickPulse)
 *   - Standard metrics collection
 *
 * Also pushes metrics to local Graphite via Carbon plaintext when configured.
 *
 * All config in extension KV (global scope). Secrets in keychain.
 */

import { hostname } from "os";
import { trace, context, SpanKind, SpanStatusCode, type Tracer, type Span } from "@opentelemetry/api";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { addLogSink, removeLogSink, type LogSink as RuntimeLogSink, type LogRecord } from "./compat/log-sink.js";

import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";
import { createLogger } from "./compat/logger.js";

const EXTENSION_ID = "observability";
const log = createLogger(EXTENSION_ID);

// ── Config ───────────────────────────────────────────────────────

export interface ObservabilityConfig {
  // General
  enabled: boolean;
  instance_name: string;

  // Azure Application Insights
  appinsights_enabled: boolean;
  appinsights_keychain: string;          // keychain entry name holding the connection string
  appinsights_live_metrics: boolean;     // enable Live Metrics Stream (QuickPulse)
  appinsights_standard_metrics: boolean; // enable standard OTel metrics collection
  appinsights_sampling_ratio: number;    // 0–1, 1 = send everything
  appinsights_browser_enabled: boolean;  // expose the connection string to the authenticated web UI for agent-centric browser events

  // Graphite (Carbon plaintext)
  graphite_enabled: boolean;
  graphite_host: string;
  graphite_port: number;
  graphite_prefix: string;
}

const DEFAULT_CONFIG: ObservabilityConfig = {
  enabled: false,
  instance_name: "",
  appinsights_enabled: true,
  appinsights_keychain: "",
  appinsights_live_metrics: true,
  appinsights_standard_metrics: true,
  appinsights_sampling_ratio: 1,
  appinsights_browser_enabled: true,
  graphite_enabled: false,
  graphite_host: "",
  graphite_port: 2003,
  graphite_prefix: "piclaw",
};

// ── KV-backed config ─────────────────────────────────────────────

let storage: ExtensionStorage | null = null;
function kv(): ExtensionStorage {
  if (!storage) storage = createExtensionStorage(EXTENSION_ID);
  return storage;
}

function loadConfig(): ObservabilityConfig {
  try {
    const saved = kv().get<Partial<ObservabilityConfig>>("config", "global");
    if (saved) return { ...DEFAULT_CONFIG, ...saved };
  } catch { /* first run */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: ObservabilityConfig): void {
  kv().set("config", config, "global");
}

// ── Keychain resolution ──────────────────────────────────────────

async function resolveSecret(keychainName: string): Promise<string | null> {
  if (!keychainName) return null;
  try {
    const { getKeychainEntry } = await import("./compat/keychain.js");
    const entry = await getKeychainEntry(keychainName);
    return entry?.secret?.trim() || null;
  } catch { return null; }
}

// ── Instance identity ────────────────────────────────────────────

function instanceName(config: ObservabilityConfig): string {
  return config.instance_name?.trim() || hostname();
}

function detectDeploymentMode(): string {
  if (process.env.PICLAW_DEPLOYMENT_MODE) return process.env.PICLAW_DEPLOYMENT_MODE.trim();
  try {
    const { existsSync } = require("fs");
    if (existsSync("/.dockerenv")) return "docker";
    if (existsSync("/run/systemd/container")) return "lxc";
  } catch {}
  return "host-native";
}

const DEPLOYMENT_MODE = detectDeploymentMode();

// ── OTel lifecycle ───────────────────────────────────────────────

let otelActive = false;
let piclawTracer: Tracer | null = null;
let shutdownFn: (() => Promise<void>) | null = null;

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

async function createOtelResource(attributes: Record<string, string>) {
  const resources = await import("@opentelemetry/resources");
  if (typeof (resources as any).resourceFromAttributes === "function") {
    return (resources as any).resourceFromAttributes(attributes);
  }
  if (typeof (resources as any).Resource === "function") {
    return new (resources as any).Resource(attributes);
  }
  return { attributes } as any;
}

async function startOtel(config: ObservabilityConfig): Promise<boolean> {
  if (otelActive) await stopOtel();

  const connectionString = config.appinsights_enabled && config.appinsights_keychain
    ? await resolveSecret(config.appinsights_keychain)
    : null;

  if (!connectionString && !config.graphite_enabled) {
    log.info("No backends configured", { operation: "otel.skip" });
    return false;
  }

  if (connectionString) {
    try {
      const { useAzureMonitor, shutdownAzureMonitor } = await import("@azure/monitor-opentelemetry");
      const resource = await createOtelResource({
        "service.name": "piclaw",
        "service.instance.id": instanceName(config),
        "service.version": process.env.npm_package_version || "unknown",
        "deployment.environment": DEPLOYMENT_MODE,
        "host.name": hostname(),
      });
      useAzureMonitor({
        azureMonitorExporterOptions: { connectionString },
        enableLiveMetrics: config.appinsights_live_metrics,
        enableStandardMetrics: config.appinsights_standard_metrics,
        samplingRatio: Math.max(0, Math.min(1, config.appinsights_sampling_ratio)),
        resource,
      });
      shutdownFn = shutdownAzureMonitor;

      log.info("Azure Monitor OTel started", {
        operation: "otel.start.appinsights",
        instance: instanceName(config),
        deployment: DEPLOYMENT_MODE,
        liveMetrics: config.appinsights_live_metrics,
        sampling: config.appinsights_sampling_ratio,
      });
    } catch (err) {
      log.error("Failed to start Azure Monitor OTel", {
        operation: "otel.start.appinsights",
        error: formatError(err),
      });
      return false;
    }
  }

  piclawTracer = trace.getTracer("piclaw", process.env.npm_package_version || "0.0.0");
  otelActive = true;
  return true;
}

async function stopOtel(): Promise<void> {
  if (shutdownFn) {
    try { await shutdownFn(); } catch (err) { log.warn("OTel shutdown error", { error: formatError(err) }); }
    shutdownFn = null;
  }
  piclawTracer = null;
  otelActive = false;
}

// ── Tracer access ────────────────────────────────────────────────

export function getTracer(): Tracer {
  return piclawTracer || trace.getTracer("piclaw-noop");
}

export function isActive(): boolean { return otelActive; }

// ── Span helpers ─────────────────────────────────────────────────

function inst(): string { return instanceName(loadConfig()); }

function syntheticResultCodeForLevel(level: string | null | undefined): number {
  switch ((level || "").toLowerCase()) {
    case "debug": return 100;
    case "info": return 200;
    case "warn": return 300;
    case "error": return 400;
    default: return 200;
  }
}

function setSyntheticResultCode(span: Span, code: number): void {
  const normalized = Number.isFinite(code) ? Math.trunc(code) : 200;
  span.setAttribute("http.status_code", normalized);
  span.setAttribute("http.response.status_code", normalized);
  span.setAttribute("piclaw.result_code", normalized);
  span.setAttribute("piclaw.result_code_source", "synthetic");
}

export function buildSyntheticRequestAttributes(
  attributes: Record<string, string | number | boolean>,
  route: string,
  instance: string,
): Record<string, string | number | boolean> {
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  return {
    ...attributes,
    "http.request.method": "POST",
    "http.route": normalizedRoute,
    "url.full": `piclaw://request${normalizedRoute}`,
    "server.address": instance,
    "network.protocol.name": "piclaw",
    "piclaw.telemetry_class": "request",
  };
}

export function buildSyntheticDependencyAttributes(
  attributes: Record<string, string | number | boolean>,
  route: string,
  target: string,
  dependencyKind: string,
): Record<string, string | number | boolean> {
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  const normalizedTarget = target.trim() || "piclaw";
  return {
    ...attributes,
    "http.request.method": "POST",
    "http.route": normalizedRoute,
    "url.full": `piclaw://${normalizedTarget}${normalizedRoute}`,
    "server.address": normalizedTarget,
    "peer.service": normalizedTarget,
    "network.protocol.name": "piclaw",
    "piclaw.telemetry_class": "dependency",
    "piclaw.dependency.kind": dependencyKind,
  };
}

export function modelDependencyTarget(model: string | null | undefined): string {
  const normalized = String(model || "").trim();
  if (!normalized) return "llm";
  const [provider] = normalized.split("/");
  return provider?.trim() || "llm";
}

export function startAgentTurnSpan(chatJid: string, opts?: { model?: string | null; turnId?: string }): Span {
  return getTracer().startSpan("agent.turn", {
    kind: SpanKind.SERVER,
    attributes: buildSyntheticRequestAttributes({
      "piclaw.chat_jid": chatJid,
      "piclaw.instance": inst(),
      ...(opts?.model ? { "piclaw.model": opts.model } : {}),
      ...(opts?.turnId ? { "piclaw.turn_id": opts.turnId } : {}),
    }, "/agent/turn", inst()),
  });
}

export function endAgentTurnSpan(span: Span, result: {
  status: "success" | "error" | "tool_complete";
  error?: string | null;
  tokenCount?: number | null;
  recovery?: { attemptsUsed?: number; exhausted?: boolean; lastClassifier?: string | null } | null;
}): void {
  if (result.status === "error") {
    span.setStatus({ code: SpanStatusCode.ERROR, message: result.error || "unknown" });
    setSyntheticResultCode(span, 400);
    if (result.error) span.recordException(new Error(result.error));
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
    setSyntheticResultCode(span, 200);
  }
  span.setAttribute("piclaw.turn.status", result.status);
  if (result.tokenCount != null) span.setAttribute("piclaw.turn.tokens", result.tokenCount);
  if (result.recovery) {
    if (result.recovery.attemptsUsed != null) span.setAttribute("piclaw.recovery.attempts", result.recovery.attemptsUsed);
    if (result.recovery.exhausted) span.setAttribute("piclaw.recovery.exhausted", true);
    if (result.recovery.lastClassifier) span.setAttribute("piclaw.recovery.classifier", result.recovery.lastClassifier);
  }
  span.end();
}

export function recordToolCall(chatJid: string, toolName: string, durationMs: number, opts?: { error?: string | null; parentSpan?: Span }): void {
  const span = getTracer().startSpan("tool.call", {
    kind: SpanKind.CLIENT,
    attributes: buildSyntheticDependencyAttributes(
      { "piclaw.chat_jid": chatJid, "piclaw.tool.name": toolName, "piclaw.instance": inst() },
      "/tool/call",
      toolName,
      "tool",
    ),
    ...(opts?.parentSpan ? { context: trace.setSpan(context.active(), opts.parentSpan) } : {}),
  });
  if (opts?.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: opts.error });
    setSyntheticResultCode(span, 400);
    span.recordException(new Error(opts.error));
  }
  else {
    span.setStatus({ code: SpanStatusCode.OK });
    setSyntheticResultCode(span, 200);
  }
  span.setAttribute("piclaw.tool.duration_ms", durationMs);
  span.end();
}

export function recordProviderError(chatJid: string, error: string, opts?: { model?: string; provider?: string; classifier?: string }): void {
  const span = getTracer().startSpan("provider.error", {
    attributes: {
      "piclaw.chat_jid": chatJid, "piclaw.instance": inst(),
      ...(opts?.model ? { "piclaw.model": opts.model } : {}),
      ...(opts?.provider ? { "piclaw.provider": opts.provider } : {}),
      ...(opts?.classifier ? { "piclaw.error.classifier": opts.classifier } : {}),
    },
  });
  span.setStatus({ code: SpanStatusCode.ERROR, message: error });
  setSyntheticResultCode(span, 400);
  span.recordException(new Error(error));
  span.end();
}

// ── Graphite Carbon plaintext ────────────────────────────────────

let graphiteSocket: ReturnType<typeof import("net").createConnection> | null = null;
let graphiteTimer: ReturnType<typeof setTimeout> | null = null;
let graphiteCfg: { host: string; port: number; prefix: string } | null = null;

function ensureGraphite(): void {
  if (!graphiteCfg?.host || graphiteSocket) return;
  try {
    const net = require("net");
    graphiteSocket = net.createConnection({ host: graphiteCfg.host, port: graphiteCfg.port }, () =>
      log.info("Graphite connected", { host: graphiteCfg!.host }));
    graphiteSocket!.on("error", () => { graphiteSocket = null; scheduleReconnect(); });
    graphiteSocket!.on("close", () => { graphiteSocket = null; scheduleReconnect(); });
  } catch { graphiteSocket = null; }
}
function scheduleReconnect(): void {
  if (graphiteTimer || !graphiteCfg?.host) return;
  graphiteTimer = setTimeout(() => { graphiteTimer = null; ensureGraphite(); }, 30_000);
}
function teardownGraphite(): void {
  if (graphiteSocket) { try { graphiteSocket.end(); } catch {} graphiteSocket = null; }
  if (graphiteTimer) { clearTimeout(graphiteTimer); graphiteTimer = null; }
  graphiteCfg = null;
}

export function recordMetric(name: string, value: number, timestampSec?: number): void {
  if (!graphiteCfg?.host) return;
  ensureGraphite();
  if (!graphiteSocket) return;
  const ts = timestampSec ?? Math.floor(Date.now() / 1000);
  const i = inst().replace(/[.\s]/g, "_");
  try { graphiteSocket.write(`${graphiteCfg.prefix}.${i}.${name} ${value} ${ts}\n`); } catch {}
}

// ── Apply config ─────────────────────────────────────────────────

async function applyConfig(config: ObservabilityConfig): Promise<void> {
  if (!config.enabled) {
    removeLogSinkBridge();
    await stopOtel();
    teardownGraphite();
    return;
  }

  await startOtel(config);

  if (config.graphite_enabled && config.graphite_host) {
    teardownGraphite();
    graphiteCfg = { host: config.graphite_host, port: config.graphite_port, prefix: config.graphite_prefix };
    ensureGraphite();
  } else {
    teardownGraphite();
  }

  installLogSinkBridge();
}

// ── Settings API ─────────────────────────────────────────────────

interface ObservabilityBrowserConfig {
  ok: true;
  enabled: boolean;
  connectionString: string | null;
  instanceName: string;
  deploymentMode: string;
  samplingRatio: number;
  actorIdentity: "chat_jid";
  actorDimension: "piclaw.chat_jid";
}

function handleGetConfig(): ObservabilityConfig { return loadConfig(); }

async function handleGetBrowserConfig(): Promise<ObservabilityBrowserConfig> {
  const config = loadConfig();
  const connectionString = config.enabled && config.appinsights_enabled && config.appinsights_browser_enabled && config.appinsights_keychain
    ? await resolveSecret(config.appinsights_keychain)
    : null;
  return {
    ok: true,
    enabled: Boolean(connectionString),
    connectionString,
    instanceName: instanceName(config),
    deploymentMode: DEPLOYMENT_MODE,
    samplingRatio: Math.max(0, Math.min(1, config.appinsights_sampling_ratio)),
    actorIdentity: "chat_jid",
    actorDimension: "piclaw.chat_jid",
  };
}

function handleSetConfig(body: Partial<ObservabilityConfig>): { ok: boolean; config: ObservabilityConfig } {
  const c = loadConfig();
  const next: ObservabilityConfig = {
    enabled:                     body.enabled ?? c.enabled,
    instance_name:               typeof body.instance_name === "string" ? body.instance_name.trim() : c.instance_name,
    appinsights_enabled:         body.appinsights_enabled ?? c.appinsights_enabled,
    appinsights_keychain:        typeof body.appinsights_keychain === "string" ? body.appinsights_keychain.trim() : c.appinsights_keychain,
    appinsights_live_metrics:    body.appinsights_live_metrics ?? c.appinsights_live_metrics,
    appinsights_standard_metrics:body.appinsights_standard_metrics ?? c.appinsights_standard_metrics,
    appinsights_sampling_ratio:  typeof body.appinsights_sampling_ratio === "number" ? Math.max(0, Math.min(1, body.appinsights_sampling_ratio)) : c.appinsights_sampling_ratio,
    appinsights_browser_enabled: body.appinsights_browser_enabled ?? c.appinsights_browser_enabled,
    graphite_enabled:            body.graphite_enabled ?? c.graphite_enabled,
    graphite_host:               typeof body.graphite_host === "string" ? body.graphite_host.trim() : c.graphite_host,
    graphite_port:               typeof body.graphite_port === "number" && body.graphite_port > 0 ? body.graphite_port : c.graphite_port,
    graphite_prefix:             typeof body.graphite_prefix === "string" ? body.graphite_prefix.trim() : c.graphite_prefix,
  };
  saveConfig(next);
  void applyConfig(next);
  return { ok: true, config: next };
}

type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: { get?: (payload: unknown, req: Request) => unknown | Promise<unknown>; set?: (payload: unknown, req: Request) => unknown | Promise<unknown> },
  extensionPath?: string,
) => "created" | "updated";

const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
if (typeof registerAddonConfigApi === "function") {
  registerAddonConfigApi("observability", "config", {
    get: async () => handleGetConfig(),
    set: async (payload) => handleSetConfig((payload && typeof payload === "object" ? payload : {}) as Partial<ObservabilityConfig>),
  }, import.meta.dir);
  registerAddonConfigApi("observability", "browser-config", {
    get: async () => await handleGetBrowserConfig(),
  }, import.meta.dir);
}

// ── Extension entry point ────────────────────────────────────────

export default function observabilityExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    const config = loadConfig();
    if (config.enabled) {
      await applyConfig(config);
    }
  });
  pi.on("session_shutdown", async () => {
    removeLogSinkBridge();
    await stopOtel();
    teardownGraphite();
  });

  pi.on("before_agent_start", async (event) => {
    const config = loadConfig();
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Observability\nOTel tracing ${config.enabled ? "active" : "disabled"}. Instance: ${instanceName(config)} (${DEPLOYMENT_MODE}).${config.appinsights_live_metrics ? " Live Metrics enabled." : ""}`,
    };
  });
}

// ── Log sink → OTel span bridge ──────────────────────────────────

let activeSink: RuntimeLogSink | null = null;

type InflightTurnEntry = { span: Span; startedAt: number; turnKey: string; nextModelSequence: number; activeModelKey: string | null };
type InflightChildSpanEntry = { span: Span; turnKey: string };

/** In-flight turn tracking for pairing prompt start → complete/error. */
const inflightTurns = new Map<string, InflightTurnEntry>();
const inflightToolCalls = new Map<string, InflightChildSpanEntry>();
const inflightModelResponses = new Map<string, InflightChildSpanEntry>();

function readRecordString(record: LogRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readRecordNumber(record: LogRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function getTurnKey(record: LogRecord, chatJid: string): string {
  return readRecordString(record, "turnId", "turn_id") || chatJid;
}

function getSharedSpanAttributes(record: LogRecord, chatJid: string, instance: string): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    "piclaw.instance": instance,
  };
  if (chatJid) {
    attrs["piclaw.chat_jid"] = chatJid;
    attrs["piclaw.actor.kind"] = "chat_jid";
    attrs["piclaw.actor.id"] = chatJid;
    attrs["enduser.id"] = chatJid;
  }
  const turnId = readRecordString(record, "turnId", "turn_id");
  if (turnId) attrs["piclaw.turn_id"] = turnId;
  const sessionLeafId = readRecordString(record, "sessionLeafId", "session_leaf_id");
  if (sessionLeafId) attrs["piclaw.session_leaf_id"] = sessionLeafId;
  const userId = readRecordString(record, "userId", "user_id");
  if (userId) attrs["piclaw.browser_user_id"] = userId;
  const sessionId = readRecordString(record, "sessionId", "session_id");
  if (sessionId) {
    attrs["piclaw.browser_session_id"] = sessionId;
    attrs["session.id"] = chatJid ? `${chatJid}:${sessionId}` : sessionId;
  }
  const clientId = readRecordString(record, "clientId", "client_id");
  if (clientId) attrs["piclaw.browser_client_id"] = clientId;
  return attrs;
}

function getInflightTurn(record: LogRecord, chatJid: string): InflightTurnEntry | null {
  return inflightTurns.get(getTurnKey(record, chatJid)) || null;
}

function clearInflightChildrenForTurn(turnKey: string, reason: string): void {
  for (const [key, entry] of inflightToolCalls) {
    if (entry.turnKey !== turnKey) continue;
    entry.span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
    setSyntheticResultCode(entry.span, 400);
    entry.span.end();
    inflightToolCalls.delete(key);
  }
  for (const [key, entry] of inflightModelResponses) {
    if (entry.turnKey !== turnKey) continue;
    entry.span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
    setSyntheticResultCode(entry.span, 400);
    entry.span.end();
    inflightModelResponses.delete(key);
  }
}

function toolSpanKey(record: LogRecord, chatJid: string, toolName: string): string {
  return readRecordString(record, "toolCallId", "tool_call_id") || `${getTurnKey(record, chatJid)}:${toolName}`;
}

function modelResponseKey(record: LogRecord, chatJid: string): string {
  const sequence = readRecordNumber(record, "sequence");
  return sequence == null ? getTurnKey(record, chatJid) : `${getTurnKey(record, chatJid)}:${sequence}`;
}

function startModelCallSpan(turnEntry: InflightTurnEntry, sharedAttrs: Record<string, string | number | boolean>, model: string | null, reason?: string | null): void {
  const sequence = turnEntry.nextModelSequence;
  const span = getTracer().startSpan("model.call", {
    kind: SpanKind.CLIENT,
    attributes: buildSyntheticDependencyAttributes({
      ...sharedAttrs,
      ...(model ? { "piclaw.model": model } : {}),
      "piclaw.model.sequence": sequence,
      ...(reason ? { "piclaw.model.resume_reason": reason } : {}),
    }, "/model/call", modelDependencyTarget(model), "model"),
    context: trace.setSpan(context.active(), turnEntry.span),
  });
  const key = `${turnEntry.turnKey}:${sequence}`;
  inflightModelResponses.set(key, { span, turnKey: turnEntry.turnKey });
  turnEntry.activeModelKey = key;
  turnEntry.nextModelSequence += 1;
}

function endModelCallSpan(turnEntry: InflightTurnEntry | null, opts: { stopReason?: string | null; errorMessage?: string | null; durationMs?: number | null; usage?: unknown; level?: string | null } = {}): void {
  if (!turnEntry?.activeModelKey) return;
  const activeKey = turnEntry.activeModelKey;
  const entry = inflightModelResponses.get(activeKey);
  if (!entry) {
    turnEntry.activeModelKey = null;
    return;
  }
  if (opts.durationMs != null) entry.span.setAttribute("piclaw.model.duration_ms", opts.durationMs);
  if (opts.stopReason) entry.span.setAttribute("piclaw.model.stop_reason", opts.stopReason);
  stampUsageAttributes(entry.span, opts.usage);
  if (opts.errorMessage) {
    entry.span.setStatus({ code: SpanStatusCode.ERROR, message: opts.errorMessage });
    setSyntheticResultCode(entry.span, 400);
    entry.span.recordException(new Error(opts.errorMessage));
  } else {
    entry.span.setStatus({ code: SpanStatusCode.OK });
    setSyntheticResultCode(entry.span, syntheticResultCodeForLevel(opts.level));
  }
  entry.span.end();
  inflightModelResponses.delete(activeKey);
  turnEntry.activeModelKey = null;
}

function stampUsageAttributes(span: Span, usage: unknown): void {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
  const record = usage as Record<string, unknown>;
  const pairs: Array<[string, string[]]> = [
    ["piclaw.model.input_tokens", ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]],
    ["piclaw.model.output_tokens", ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]],
    ["piclaw.model.cache_read_tokens", ["cacheReadTokens", "cache_read_tokens"]],
    ["piclaw.model.cache_write_tokens", ["cacheWriteTokens", "cache_write_tokens"]],
    ["piclaw.model.total_tokens", ["totalTokens", "total_tokens"]],
  ];
  for (const [attr, keys] of pairs) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        span.setAttribute(attr, value);
        break;
      }
    }
  }
}

function installLogSinkBridge(): void {
  if (activeSink) return;
  activeSink = bridgeSink;
  addLogSink(activeSink);
}

function removeLogSinkBridge(): void {
  if (!activeSink) return;
  removeLogSink(activeSink);
  activeSink = null;
  for (const [, entry] of inflightTurns) {
    entry.span.setStatus({ code: SpanStatusCode.ERROR, message: "session shutdown" });
    setSyntheticResultCode(entry.span, 400);
    entry.span.end();
  }
  for (const [, entry] of inflightToolCalls) {
    entry.span.setStatus({ code: SpanStatusCode.ERROR, message: "session shutdown" });
    setSyntheticResultCode(entry.span, 400);
    entry.span.end();
  }
  for (const [, entry] of inflightModelResponses) {
    entry.span.setStatus({ code: SpanStatusCode.ERROR, message: "session shutdown" });
    setSyntheticResultCode(entry.span, 400);
    entry.span.end();
  }
  inflightTurns.clear();
  inflightToolCalls.clear();
  inflightModelResponses.clear();
}

function bridgeSink(record: LogRecord): void {
  if (!otelActive) return;
  const op = typeof record.operation === "string" ? record.operation : "";
  if (!op) return;

  const chatJid = typeof record.chatJid === "string" ? record.chatJid : "";
  const i = inst();
  const sharedAttrs = getSharedSpanAttributes(record, chatJid, i);
  const turnKey = getTurnKey(record, chatJid);

  if (op === "run_agent.prompt" && chatJid) {
    const span = getTracer().startSpan("agent.turn", {
      kind: SpanKind.SERVER,
      attributes: buildSyntheticRequestAttributes({
        ...sharedAttrs,
        ...(record.model ? { "piclaw.model": String(record.model) } : {}),
      }, "/agent/turn", i),
    });
    const turnEntry: InflightTurnEntry = {
      span,
      startedAt: Date.now(),
      turnKey,
      nextModelSequence: 1,
      activeModelKey: null,
    };
    inflightTurns.set(turnKey, turnEntry);
    startModelCallSpan(turnEntry, sharedAttrs, record.model ? String(record.model) : null, "initial_prompt");
    return;
  }

  if (op === "model.response.start" && chatJid) {
    const parentEntry = getInflightTurn(record, chatJid);
    if (parentEntry && !parentEntry.activeModelKey) {
      if (readRecordNumber(record, "sequence") != null) parentEntry.nextModelSequence = readRecordNumber(record, "sequence")!;
      startModelCallSpan(parentEntry, sharedAttrs, record.model ? String(record.model) : null, readRecordString(record, "phase"));
    }
    return;
  }

  if (op === "model.response.end" && chatJid) {
    const parentEntry = getInflightTurn(record, chatJid);
    const durationMs = readRecordNumber(record, "durationMs", "duration_ms");
    endModelCallSpan(parentEntry, {
      durationMs,
      stopReason: readRecordString(record, "stopReason", "stop_reason"),
      errorMessage: readRecordString(record, "errorMessage", "error_message"),
      usage: (record as Record<string, unknown>).usage,
      level: record.level,
    });
    recordMetric("model.call.count", 1);
    if (durationMs != null) recordMetric("model.call.duration_ms", durationMs);
    return;
  }

  if (op === "run_agent.complete" && chatJid) {
    const entry = getInflightTurn(record, chatJid);
    if (entry) {
      endModelCallSpan(entry, { stopReason: "turn_complete", level: record.level });
      clearInflightChildrenForTurn(entry.turnKey, "turn completed");
      entry.span.setStatus({ code: SpanStatusCode.OK });
      setSyntheticResultCode(entry.span, 200);
      entry.span.setAttribute("piclaw.turn.status", "success");
      if (typeof record.durationMs === "number") entry.span.setAttribute("piclaw.turn.duration_ms", record.durationMs);
      if (typeof record.outputChars === "number") entry.span.setAttribute("piclaw.turn.output_chars", record.outputChars);
      if (typeof record.recoveryAttemptsUsed === "number") entry.span.setAttribute("piclaw.recovery.attempts", record.recoveryAttemptsUsed);
      entry.span.end();
      inflightTurns.delete(entry.turnKey);
    }
    recordMetric("agent.turn.count", 1);
    recordMetric("agent.turn.success", 1);
    if (typeof record.durationMs === "number") recordMetric("agent.turn.duration_ms", record.durationMs);
    return;
  }

  if ((op === "run_agent" || op === "run_agent.attempt_failed") && record.level === "error" && chatJid) {
    const entry = getInflightTurn(record, chatJid);
    const errorMsg = typeof record.errorMessage === "string" ? record.errorMessage : typeof record.errorText === "string" ? record.errorText : "unknown";
    if (entry) {
      endModelCallSpan(entry, { errorMessage: errorMsg, level: record.level });
      clearInflightChildrenForTurn(entry.turnKey, errorMsg);
      entry.span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
      setSyntheticResultCode(entry.span, 400);
      entry.span.recordException(new Error(errorMsg));
      entry.span.setAttribute("piclaw.turn.status", "error");
      if (typeof record.durationMs === "number") entry.span.setAttribute("piclaw.turn.duration_ms", record.durationMs);
      if (typeof record.classifier === "string") entry.span.setAttribute("piclaw.error.classifier", record.classifier);
      entry.span.end();
      inflightTurns.delete(entry.turnKey);
    }
    recordMetric("agent.turn.count", 1);
    recordMetric("agent.turn.error", 1);
    return;
  }

  if (op === "run_agent.no_terminal_reply" && chatJid) {
    const entry = getInflightTurn(record, chatJid);
    const detail = typeof record.detail === "string" ? record.detail : "no terminal reply";
    if (entry) {
      endModelCallSpan(entry, { errorMessage: detail, level: record.level });
      clearInflightChildrenForTurn(entry.turnKey, detail);
      entry.span.setStatus({ code: SpanStatusCode.ERROR, message: detail });
      setSyntheticResultCode(entry.span, syntheticResultCodeForLevel(record.level));
      entry.span.recordException(new Error(detail));
      entry.span.setAttribute("piclaw.turn.status", "no_reply");
      entry.span.end();
      inflightTurns.delete(entry.turnKey);
    }
    recordMetric("agent.turn.count", 1);
    recordMetric("agent.turn.error", 1);
    return;
  }

  if (op === "tool.call.start" && chatJid) {
    const toolName = typeof record.toolName === "string" ? record.toolName : "unknown";
    const parentEntry = getInflightTurn(record, chatJid);
    endModelCallSpan(parentEntry, { stopReason: "tool_use", level: record.level });
    const span = getTracer().startSpan("tool.call", {
      kind: SpanKind.CLIENT,
      attributes: buildSyntheticDependencyAttributes({
        ...sharedAttrs,
        "piclaw.tool.name": toolName,
        ...(readRecordString(record, "toolCallId", "tool_call_id") ? { "piclaw.tool.call_id": readRecordString(record, "toolCallId", "tool_call_id")! } : {}),
      }, "/tool/call", toolName, "tool"),
      ...(parentEntry ? { context: trace.setSpan(context.active(), parentEntry.span) } : {}),
    });
    inflightToolCalls.set(toolSpanKey(record, chatJid, toolName), { span, turnKey });
    return;
  }

  if (op === "tool.call.end" && chatJid) {
    const toolName = typeof record.toolName === "string" ? record.toolName : "unknown";
    const isError = Boolean(record.isError);
    const durationMs = typeof record.durationMs === "number" ? record.durationMs : 0;
    const key = toolSpanKey(record, chatJid, toolName);
    const existing = inflightToolCalls.get(key);
    const parentEntry = getInflightTurn(record, chatJid);
    const span = existing?.span ?? getTracer().startSpan("tool.call", {
      kind: SpanKind.CLIENT,
      attributes: buildSyntheticDependencyAttributes({
        ...sharedAttrs,
        "piclaw.tool.name": toolName,
      }, "/tool/call", toolName, "tool"),
      ...(parentEntry ? { context: trace.setSpan(context.active(), parentEntry.span) } : {}),
    });
    span.setAttribute("piclaw.tool.duration_ms", durationMs);
    if (isError) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${toolName} failed` });
      setSyntheticResultCode(span, 400);
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
      setSyntheticResultCode(span, syntheticResultCodeForLevel(record.level));
    }
    span.end();
    inflightToolCalls.delete(key);
    const parent = existing?.turnKey ? inflightTurns.get(existing.turnKey) : parentEntry;
    if (parent && !parent.activeModelKey) {
      startModelCallSpan(parent, getSharedSpanAttributes(record, chatJid, i), record.model ? String(record.model) : null, "tool_result");
    }
    const safeName = toolName.replace(/[.\s]/g, "_");
    recordMetric(`tool.${safeName}.count`, 1);
    if (durationMs) recordMetric(`tool.${safeName}.duration_ms`, durationMs);
    if (isError) recordMetric(`tool.${safeName}.error`, 1);
    return;
  }

  if (op === "run_agent.attempt_failed" && record.level === "warn") {
    const classifier = typeof record.classifier === "string" ? record.classifier : "unknown";
    recordMetric("recovery.attempts", 1);
    recordMetric(`provider.error.${classifier.replace(/[.\s]/g, "_")}`, 1);
    const parentEntry = getInflightTurn(record, chatJid);
    const span = getTracer().startSpan("provider.error", {
      attributes: {
        ...sharedAttrs,
        "piclaw.error.classifier": classifier,
        ...(record.model ? { "piclaw.model": String(record.model) } : {}),
      },
      ...(parentEntry ? { context: trace.setSpan(context.active(), parentEntry.span) } : {}),
    });
    const errText = typeof record.errorText === "string" ? record.errorText : classifier;
    span.setStatus({ code: SpanStatusCode.ERROR, message: errText });
    setSyntheticResultCode(span, syntheticResultCodeForLevel(record.level));
    span.recordException(new Error(errText));
    span.end();
    return;
  }

  if (op === "get_or_create.create_main_session") {
    recordMetric("session.created", 1);
    return;
  }
  if (op.startsWith("evict_idle.")) {
    recordMetric("session.evicted", 1);
    return;
  }

  if (op === "dream.complete") {
    const durationMs = typeof record.durationMs === "number" ? record.durationMs : 0;
    const span = getTracer().startSpan("dream", {
      attributes: {
        ...sharedAttrs,
        "piclaw.dream.mode": typeof record.mode === "string" ? record.mode : "unknown",
        "piclaw.dream.days": typeof record.days === "number" ? record.days : 0,
        "piclaw.dream.duration_ms": durationMs,
      },
    });
    span.setStatus({ code: SpanStatusCode.OK });
    setSyntheticResultCode(span, 200);
    span.end();
    recordMetric("dream.duration_ms", durationMs);
    return;
  }

  if ((record.level === "warn" || record.level === "error") && op && !op.startsWith("handle_agent_message")) {
    const span = getTracer().startSpan(`log.${record.level}`, {
      attributes: {
        ...sharedAttrs,
        "piclaw.operation": op,
        "piclaw.module": record.module,
      },
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: record.message });
    setSyntheticResultCode(span, syntheticResultCodeForLevel(record.level));
    if (record.level === "error") span.recordException(new Error(record.message));
    span.end();
  }
}
