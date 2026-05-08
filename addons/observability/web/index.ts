/**
 * observability/web/index.ts — Settings pane + browser-side agent telemetry.
 *
 * Config in extension KV. Connection string saved directly to keychain.
 */
// @ts-nocheck
const ADDON_ID = "observability";
const API = `/agent/addons/api/${ADDON_ID}`;
const BROWSER_CONFIG_API = `${API}/browser-config`;
const KEYCHAIN_ENTRY = "azure/appinsights-connection-string";
const APP_INSIGHTS_SDK_URL = "https://js.monitor.azure.com/scripts/b/ai.3.gbl.min.js";
const DEFAULT_CHAT_JID = "web:default";

const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
const html = preactHtm?.html;
const useState = preactHtm?.useState;
const useEffect = preactHtm?.useEffect;
const useCallback = preactHtm?.useCallback;
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

const ICON = HAS_RUNTIME
  ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`
  : null;

const OBS_USER_ID_KEY = "piclaw.observability.userId";
const OBS_SESSION_ID_KEY = "piclaw.observability.sessionId";
const OBS_CLIENT_ID_KEY = "piclaw.observability.clientId";

function createId(prefix) {
  try {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  } catch {}
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function getOrCreateStorageId(storage, key, prefix) {
  try {
    const existing = storage?.getItem?.(key);
    if (existing && existing.trim()) return existing.trim();
    const created = createId(prefix);
    storage?.setItem?.(key, created);
    return created;
  } catch {
    return createId(prefix);
  }
}

function getBrowserObservabilityIds() {
  if (typeof window === "undefined") return { userId: null, sessionId: null, clientId: null };
  const existing = window.__PICLAW_OBSERVABILITY_IDS__;
  if (existing?.userId && existing?.sessionId && existing?.clientId) return existing;
  const ids = {
    userId: getOrCreateStorageId(window.localStorage, OBS_USER_ID_KEY, "user"),
    sessionId: getOrCreateStorageId(window.sessionStorage, OBS_SESSION_ID_KEY, "session"),
    clientId: getOrCreateStorageId(window.sessionStorage, OBS_CLIENT_ID_KEY, "client"),
  };
  window.__PICLAW_OBSERVABILITY_IDS__ = ids;
  return ids;
}

export function normalizeChatJid(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

export function parseChatJidFromUrl(rawUrl, baseHref = "https://example.test/") {
  try {
    const url = new URL(String(rawUrl || ""), baseHref);
    const chatJid = normalizeChatJid(url.searchParams.get("chat_jid"));
    if (chatJid) return chatJid;
    if (url.pathname === "/sse/stream") return DEFAULT_CHAT_JID;
    if (url.pathname.startsWith("/agent/")) return DEFAULT_CHAT_JID;
  } catch {}
  return null;
}

function readPayloadString(payload, ...keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readPayloadNumber(payload, ...keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function pickAgentMeasurements(payload) {
  const measurements = {};
  const retryDelayMs = readPayloadNumber(payload, "retry_delay_ms", "retryDelayMs");
  const attemptsUsed = readPayloadNumber(payload, "attempts_used", "attemptsUsed");
  const queueCount = readPayloadNumber(payload, "queue_count", "queueCount", "remaining_queue_count", "remainingQueueCount");
  const contextPercent = typeof payload?.context_usage?.percent === "number" ? payload.context_usage.percent : null;
  if (retryDelayMs != null) measurements.retryDelayMs = retryDelayMs;
  if (attemptsUsed != null) measurements.attemptsUsed = attemptsUsed;
  if (queueCount != null) measurements.queueCount = queueCount;
  if (contextPercent != null) measurements.contextPercent = contextPercent;
  return measurements;
}

function buildTelemetryProperties(payload, chatJid) {
  const turnId = readPayloadString(payload, "turn_id", "turnId");
  return {
    ...(chatJid ? { "piclaw.chat_jid": chatJid, "piclaw.actor.kind": "chat_jid", "piclaw.actor.id": chatJid } : {}),
    ...(turnId ? { "piclaw.turn_id": turnId } : {}),
    ...(readPayloadString(payload, "agent_id", "agentId") ? { "piclaw.agent_id": readPayloadString(payload, "agent_id", "agentId") } : {}),
    ...(readPayloadString(payload, "thread_id", "threadId") ? { "piclaw.thread_id": readPayloadString(payload, "thread_id", "threadId") } : {}),
    ...(readPayloadString(payload, "type") ? { "piclaw.status_type": readPayloadString(payload, "type") } : {}),
    ...(readPayloadString(payload, "title") ? { "piclaw.title": readPayloadString(payload, "title") } : {}),
    ...(readPayloadString(payload, "detail") ? { "piclaw.detail": readPayloadString(payload, "detail") } : {}),
    ...(readPayloadString(payload, "mode") ? { "piclaw.mode": readPayloadString(payload, "mode") } : {}),
    ...(readPayloadString(payload, "classifier") ? { "piclaw.classifier": readPayloadString(payload, "classifier") } : {}),
  };
}

function ensureTurnStateContainer(state) {
  if (!state.turnStates || typeof state.turnStates !== "object") state.turnStates = {};
  return state.turnStates;
}

export function deriveTelemetryEventsFromSse(eventType, payload, state = {}) {
  const chatJid = normalizeChatJid(payload?.chat_jid) || normalizeChatJid(state.activeChatJid) || null;
  const turnId = readPayloadString(payload, "turn_id", "turnId");
  const events = [];
  const turnStates = ensureTurnStateContainer(state);
  const turnKey = chatJid && turnId ? `${chatJid}:${turnId}` : null;
  const currentTurnState = turnKey ? (turnStates[turnKey] || {}) : null;

  if (chatJid) state.activeChatJid = chatJid;
  if (turnId) state.activeTurnId = turnId;

  if (eventType === "agent_status") {
    const statusType = readPayloadString(payload, "type") || "unknown";
    if (statusType === "done") {
      events.push({
        name: "agent.turn.complete",
        chatJid,
        turnId,
        properties: buildTelemetryProperties(payload, chatJid),
        measurements: pickAgentMeasurements(payload),
      });
      if (turnKey) delete turnStates[turnKey];
      return events;
    }
    if (statusType === "error") {
      events.push({
        name: "agent.turn.fail",
        chatJid,
        turnId,
        properties: buildTelemetryProperties(payload, chatJid),
        measurements: pickAgentMeasurements(payload),
      });
      if (turnKey) delete turnStates[turnKey];
      return events;
    }

    if (turnKey && !currentTurnState.started) {
      turnStates[turnKey] = { ...(currentTurnState || {}), started: true, lastStatus: statusType };
      events.push({
        name: "agent.turn.start",
        chatJid,
        turnId,
        properties: buildTelemetryProperties(payload, chatJid),
        measurements: pickAgentMeasurements(payload),
      });
    }

    if (turnKey) {
      const latest = turnStates[turnKey] || { started: true };
      if (latest.lastStatus !== statusType) {
        latest.lastStatus = statusType;
        turnStates[turnKey] = latest;
        events.push({
          name: "agent.turn.phase",
          chatJid,
          turnId,
          properties: buildTelemetryProperties(payload, chatJid),
          measurements: pickAgentMeasurements(payload),
        });
      }
    }
    return events;
  }

  const mappedEventName = {
    agent_followup_queued: "agent.followup.queued",
    agent_followup_consumed: "agent.followup.consumed",
    agent_followup_removed: "agent.followup.removed",
    agent_steer_queued: "agent.steer.queued",
    model_changed: "agent.model.changed",
  }[eventType];

  if (!mappedEventName) return events;
  events.push({
    name: mappedEventName,
    chatJid,
    turnId,
    properties: buildTelemetryProperties(payload, chatJid),
    measurements: pickAgentMeasurements(payload),
  });
  return events;
}

function getTelemetryRuntimeState() {
  if (typeof window === "undefined") return { turnStates: {}, eventQueue: [] };
  if (!window.__piclawObservabilityAgentTelemetryState) {
    window.__piclawObservabilityAgentTelemetryState = {
      activeChatJid: null,
      activeTurnId: null,
      actorChatJid: null,
      actorSessionId: null,
      browserConfig: null,
      appInsights: null,
      turnStates: {},
      eventQueue: [],
      initialized: false,
      browserTelemetryEnabled: false,
    };
  }
  return window.__piclawObservabilityAgentTelemetryState;
}

function loadScriptOnce(src) {
  if (typeof document === "undefined") return Promise.resolve(null);
  window.__piclawObservabilityScriptPromises ||= {};
  if (window.__piclawObservabilityScriptPromises[src]) return window.__piclawObservabilityScriptPromises[src];
  window.__piclawObservabilityScriptPromises[src] = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-piclaw-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve(existing);
        return;
      }
      existing.addEventListener("load", () => resolve(existing), { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.piclawSrc = src;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve(script);
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return window.__piclawObservabilityScriptPromises[src];
}

async function loadBrowserTelemetryConfig() {
  if (typeof window === "undefined") return null;
  if (window.__piclawObservabilityBrowserConfigPromise) return window.__piclawObservabilityBrowserConfigPromise;
  const fetchImpl = window.__piclawObservabilityOriginalFetch || window.fetch?.bind(window);
  if (!fetchImpl) return null;
  window.__piclawObservabilityBrowserConfigPromise = (async () => {
    try {
      const response = await fetchImpl(BROWSER_CONFIG_API, { credentials: "same-origin" });
      if (!response.ok) return null;
      const payload = await response.json().catch(() => null);
      return payload?.enabled ? payload : null;
    } catch {
      return null;
    }
  })();
  return window.__piclawObservabilityBrowserConfigPromise;
}

function resolveAppInsightsConstructor() {
  return window?.Microsoft?.ApplicationInsights?.ApplicationInsights
    || window?.Microsoft?.ApplicationInsights3?.ApplicationInsights
    || null;
}

function createAppInsightsClient(browserConfig) {
  const AppInsightsCtor = resolveAppInsightsConstructor();
  if (!AppInsightsCtor || !browserConfig?.connectionString) return null;
  const samplingPercentage = Math.max(0, Math.min(100, Number(browserConfig.samplingRatio || 1) * 100));
  const client = new AppInsightsCtor({
    config: {
      connectionString: browserConfig.connectionString,
      samplingPercentage,
      disableAjaxTracking: true,
      disableFetchTracking: true,
      enableAutoRouteTracking: false,
      enableCorsCorrelation: true,
    },
  });
  try {
    client.loadAppInsights?.();
  } catch {}
  return client;
}

function safeTrackPageView(appInsights, browserConfig) {
  if (!appInsights) return;
  const baseProps = {
    "piclaw.actor.kind": "chat_jid",
    "piclaw.browser_session_id": getBrowserObservabilityIds().sessionId,
    "piclaw.browser_client_id": getBrowserObservabilityIds().clientId,
    "piclaw.instance": browserConfig?.instanceName || null,
    "piclaw.deployment": browserConfig?.deploymentMode || null,
  };
  try {
    appInsights.trackPageView?.({ name: "piclaw.web", uri: window.location.href }, baseProps);
    return;
  } catch {}
  try {
    appInsights.trackPageView?.({ name: "piclaw.web", uri: window.location.href, properties: baseProps });
  } catch {}
}

function safeTrackEvent(appInsights, name, properties, measurements) {
  if (!appInsights?.trackEvent) return false;
  try {
    appInsights.trackEvent({ name }, properties, measurements);
    return true;
  } catch {}
  try {
    appInsights.trackEvent({ name, properties, measurements });
    return true;
  } catch {}
  return false;
}

function applyActorContext(chatJid) {
  const normalized = normalizeChatJid(chatJid);
  const state = getTelemetryRuntimeState();
  const appInsights = state.appInsights;
  if (!normalized || !appInsights) return;
  const ids = getBrowserObservabilityIds();
  const actorSessionId = `${normalized}:${ids.sessionId || "session"}`;
  if (state.actorChatJid === normalized && state.actorSessionId === actorSessionId) return;
  state.activeChatJid = normalized;
  state.actorChatJid = normalized;
  state.actorSessionId = actorSessionId;
  try { appInsights.setAuthenticatedUserContext?.(normalized); } catch {}
  try { appInsights.context?.user?.setAuthenticatedUserContext?.(normalized); } catch {}
  try { if (appInsights.context?.user) appInsights.context.user.id = normalized; } catch {}
  try { if (appInsights.context?.session) appInsights.context.session.id = actorSessionId; } catch {}
}

function enrichTelemetryProperties(chatJid, properties = {}) {
  const state = getTelemetryRuntimeState();
  const ids = getBrowserObservabilityIds();
  const normalizedChatJid = normalizeChatJid(chatJid) || normalizeChatJid(state.activeChatJid) || null;
  return {
    ...properties,
    ...(normalizedChatJid ? { "piclaw.chat_jid": normalizedChatJid, "piclaw.actor.kind": "chat_jid", "piclaw.actor.id": normalizedChatJid } : {}),
    ...(ids.userId ? { "piclaw.browser_user_id": ids.userId } : {}),
    ...(ids.sessionId ? { "piclaw.browser_session_id": ids.sessionId } : {}),
    ...(ids.clientId ? { "piclaw.browser_client_id": ids.clientId } : {}),
    ...(state.browserConfig?.instanceName ? { "piclaw.instance": state.browserConfig.instanceName } : {}),
    ...(state.browserConfig?.deploymentMode ? { "piclaw.deployment": state.browserConfig.deploymentMode } : {}),
  };
}

function queueTelemetryEvent(event) {
  const state = getTelemetryRuntimeState();
  state.eventQueue.push(event);
  if (state.eventQueue.length > 200) state.eventQueue.splice(0, state.eventQueue.length - 200);
}

function flushQueuedTelemetry() {
  const state = getTelemetryRuntimeState();
  if (!state.appInsights || !state.eventQueue.length) return;
  const pending = state.eventQueue.splice(0, state.eventQueue.length);
  for (const event of pending) {
    applyActorContext(event.chatJid);
    safeTrackEvent(state.appInsights, event.name, event.properties, event.measurements);
  }
}

async function ensureBrowserAgentTelemetryReady(preloadedBrowserConfig = null) {
  if (typeof window === "undefined") return null;
  if (window.__piclawObservabilityTelemetryReadyPromise) return window.__piclawObservabilityTelemetryReadyPromise;
  window.__piclawObservabilityTelemetryReadyPromise = (async () => {
    const state = getTelemetryRuntimeState();
    const browserConfig = preloadedBrowserConfig || await loadBrowserTelemetryConfig();
    if (!browserConfig?.enabled) return null;
    state.browserConfig = browserConfig;
    await loadScriptOnce(APP_INSIGHTS_SDK_URL);
    const appInsights = createAppInsightsClient(browserConfig);
    if (!appInsights) return null;
    state.appInsights = appInsights;
    safeTrackPageView(appInsights, browserConfig);
    flushQueuedTelemetry();
    return appInsights;
  })();
  return window.__piclawObservabilityTelemetryReadyPromise;
}

function emitAgentTelemetryEvent(name, options = {}) {
  const state = getTelemetryRuntimeState();
  if (!state.browserTelemetryEnabled) return;
  const chatJid = normalizeChatJid(options.chatJid) || normalizeChatJid(state.activeChatJid) || null;
  const event = {
    name,
    chatJid,
    properties: enrichTelemetryProperties(chatJid, options.properties || {}),
    measurements: options.measurements || {},
  };
  if (!state.appInsights) {
    queueTelemetryEvent(event);
    void ensureBrowserAgentTelemetryReady();
    return;
  }
  applyActorContext(chatJid);
  safeTrackEvent(state.appInsights, event.name, event.properties, event.measurements);
}

function handleDerivedTelemetryEvents(events) {
  for (const event of events || []) {
    emitAgentTelemetryEvent(event.name, {
      chatJid: event.chatJid,
      properties: event.properties,
      measurements: event.measurements,
    });
  }
}

function handleSseTelemetryEvent(eventType, payload, defaultChatJid) {
  const state = getTelemetryRuntimeState();
  const normalizedChatJid = normalizeChatJid(payload?.chat_jid) || normalizeChatJid(defaultChatJid) || normalizeChatJid(state.activeChatJid) || null;
  const enrichedPayload = normalizedChatJid ? { ...payload, chat_jid: normalizedChatJid } : payload;
  handleDerivedTelemetryEvents(deriveTelemetryEventsFromSse(eventType, enrichedPayload, state));
}

function attachObservabilitySseListeners(eventSource, rawUrl) {
  if (!eventSource || typeof eventSource.addEventListener !== "function") return;
  const baseHref = typeof window !== "undefined" ? window.location.href : "https://example.test/";
  const parsedUrl = new URL(String(rawUrl || ""), baseHref);
  if (parsedUrl.pathname !== "/sse/stream") return;
  const defaultChatJid = parseChatJidFromUrl(parsedUrl.href, baseHref);
  const state = getTelemetryRuntimeState();
  if (defaultChatJid) state.activeChatJid = defaultChatJid;

  eventSource.addEventListener("connected", () => {
    if (!defaultChatJid) return;
    emitAgentTelemetryEvent("agent.stream.connected", {
      chatJid: defaultChatJid,
      properties: {
        "piclaw.sse.path": parsedUrl.pathname,
      },
    });
  });

  [
    "agent_status",
    "agent_steer_queued",
    "agent_followup_queued",
    "agent_followup_consumed",
    "agent_followup_removed",
    "model_changed",
  ].forEach((eventType) => {
    eventSource.addEventListener(eventType, (event) => {
      try {
        const payload = JSON.parse(event.data || "{}");
        handleSseTelemetryEvent(eventType, payload, defaultChatJid);
      } catch {}
    });
  });
}

async function readFetchBodyText(input, init) {
  if (typeof input !== "undefined" && input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return "";
    }
  }
  if (typeof init?.body === "string") return init.body;
  return "";
}

async function buildFetchTelemetrySpec(input, init, targetUrl, state) {
  const request = input instanceof Request ? input : null;
  const method = String(request?.method || init?.method || "GET").toUpperCase();
  if (method !== "POST") return null;
  const path = targetUrl.pathname;
  const chatJid = parseChatJidFromUrl(targetUrl.href, window.location.href) || normalizeChatJid(state.activeChatJid) || DEFAULT_CHAT_JID;

  if (/^\/agent\/[^/]+\/message$/.test(path)) {
    const bodyText = await readFetchBodyText(input, init);
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {}
    const agentId = path.split("/")[2] || null;
    return {
      name: "agent.message.sent",
      failureName: "agent.message.failed",
      chatJid,
      properties: {
        "piclaw.chat_jid": chatJid,
        ...(agentId ? { "piclaw.agent_id": agentId } : {}),
        ...(readPayloadString(body, "mode") ? { "piclaw.mode": readPayloadString(body, "mode") } : {}),
      },
      measurements: {
        mediaCount: Array.isArray(body?.media_ids) ? body.media_ids.length : 0,
      },
    };
  }

  if (path === "/agent/queue-steer") {
    return { name: "agent.steer.requested", failureName: "agent.steer.request_failed", chatJid, properties: { "piclaw.chat_jid": chatJid }, measurements: {} };
  }
  if (path === "/agent/queue-remove") {
    return { name: "agent.followup.remove.requested", failureName: "agent.followup.remove.request_failed", chatJid, properties: { "piclaw.chat_jid": chatJid }, measurements: {} };
  }

  return null;
}

function installObservabilityFetchHeaders() {
  if (typeof window === "undefined" || window.__piclawObservabilityFetchHeadersInstalled) return;

  const ids = getBrowserObservabilityIds();
  const originalFetch = window.__piclawObservabilityOriginalFetch || window.fetch?.bind(window);
  if (!originalFetch) return;

  window.__piclawObservabilityOriginalFetch = originalFetch;
  window.__piclawObservabilityFetchHeadersInstalled = true;
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const rawUrl = request ? request.url : String(input || "");
    let targetUrl = null;
    try { targetUrl = new URL(rawUrl, window.location.href); } catch {}
    if (!targetUrl || targetUrl.origin !== window.location.origin) {
      return originalFetch(input, init);
    }

    const state = getTelemetryRuntimeState();
    const inferredChatJid = parseChatJidFromUrl(targetUrl.href, window.location.href);
    if (inferredChatJid) state.activeChatJid = inferredChatJid;

    const headers = new Headers(request ? request.headers : (init?.headers || undefined));
    headers.set("x-piclaw-user-id", ids.userId);
    headers.set("x-piclaw-session-id", ids.sessionId);
    headers.set("x-piclaw-client-id", ids.clientId);

    const shouldTrackFetch = targetUrl.pathname !== "/agent/addons/api/observability/browser-config";
    const telemetrySpec = shouldTrackFetch
      ? await buildFetchTelemetrySpec(input, init, targetUrl, state)
      : null;

    try {
      const response = request
        ? await originalFetch(new Request(request, { headers }), init)
        : await originalFetch(input, { ...(init || {}), headers });
      if (telemetrySpec && response.ok) {
        emitAgentTelemetryEvent(telemetrySpec.name, {
          chatJid: telemetrySpec.chatJid,
          properties: telemetrySpec.properties,
          measurements: telemetrySpec.measurements,
        });
      }
      return response;
    } catch (error) {
      if (telemetrySpec?.failureName) {
        emitAgentTelemetryEvent(telemetrySpec.failureName, {
          chatJid: telemetrySpec.chatJid,
          properties: {
            ...telemetrySpec.properties,
            "piclaw.error": String(error?.message || error || "fetch failed"),
          },
          measurements: telemetrySpec.measurements,
        });
      }
      throw error;
    }
  };
}

function uninstallObservabilityFetchHeaders() {
  if (typeof window === "undefined" || !window.__piclawObservabilityFetchHeadersInstalled) return;
  if (window.__piclawObservabilityOriginalFetch) window.fetch = window.__piclawObservabilityOriginalFetch;
  window.__piclawObservabilityFetchHeadersInstalled = false;
}

function installObservabilityEventSourceBridge() {
  if (typeof window === "undefined" || window.__piclawObservabilityEventSourceInstalled) return;
  const OriginalEventSource = window.__piclawObservabilityOriginalEventSource || window.EventSource;
  if (typeof OriginalEventSource !== "function") return;
  window.__piclawObservabilityEventSourceInstalled = true;
  window.__piclawObservabilityOriginalEventSource = OriginalEventSource;

  function WrappedEventSource(url, configuration) {
    const eventSource = configuration === undefined
      ? new OriginalEventSource(url)
      : new OriginalEventSource(url, configuration);
    try {
      attachObservabilitySseListeners(eventSource, typeof url === "string" ? url : String(url || ""));
    } catch {}
    return eventSource;
  }

  WrappedEventSource.prototype = OriginalEventSource.prototype;
  Object.setPrototypeOf(WrappedEventSource, OriginalEventSource);
  WrappedEventSource.CONNECTING = OriginalEventSource.CONNECTING;
  WrappedEventSource.OPEN = OriginalEventSource.OPEN;
  WrappedEventSource.CLOSED = OriginalEventSource.CLOSED;
  window.EventSource = WrappedEventSource;
}

function uninstallObservabilityEventSourceBridge() {
  if (typeof window === "undefined" || !window.__piclawObservabilityEventSourceInstalled) return;
  if (window.__piclawObservabilityOriginalEventSource) window.EventSource = window.__piclawObservabilityOriginalEventSource;
  window.__piclawObservabilityEventSourceInstalled = false;
}

function installAgentTelemetry(browserConfig) {
  if (typeof window === "undefined") return;
  const state = getTelemetryRuntimeState();
  if (window.__piclawObservabilityAgentTelemetryInstalled) return;
  window.__piclawObservabilityAgentTelemetryInstalled = true;
  state.browserTelemetryEnabled = true;
  state.browserConfig = browserConfig || state.browserConfig;
  installObservabilityFetchHeaders();
  installObservabilityEventSourceBridge();
  void ensureBrowserAgentTelemetryReady(browserConfig || null);
}

function disableAgentTelemetry() {
  if (typeof window === "undefined") return;
  const state = getTelemetryRuntimeState();
  state.browserTelemetryEnabled = false;
  state.appInsights = null;
  state.browserConfig = null;
  state.eventQueue = [];
  window.__piclawObservabilityAgentTelemetryInstalled = false;
  window.__piclawObservabilityTelemetryReadyPromise = null;
  uninstallObservabilityFetchHeaders();
  uninstallObservabilityEventSourceBridge();
}

function resetBrowserTelemetryConfigCache() {
  if (typeof window === "undefined") return;
  window.__piclawObservabilityBrowserConfigPromise = null;
  window.__piclawObservabilityTelemetryReadyPromise = null;
}

export function isBrowserTelemetryConfigEnabled(config) {
  return Boolean(config?.enabled && config?.appinsights_enabled && config?.appinsights_browser_enabled && config?.appinsights_keychain);
}

async function bootstrapBrowserTelemetryIfEnabled() {
  if (typeof window === "undefined") return null;
  if (window.__piclawObservabilityBrowserTelemetryBootstrapPromise) return window.__piclawObservabilityBrowserTelemetryBootstrapPromise;
  window.__piclawObservabilityBrowserTelemetryBootstrapPromise = (async () => {
    const browserConfig = await loadBrowserTelemetryConfig();
    if (!browserConfig?.enabled) {
      disableAgentTelemetry();
      return null;
    }
    installAgentTelemetry(browserConfig);
    return browserConfig;
  })();
  return window.__piclawObservabilityBrowserTelemetryBootstrapPromise;
}

function syncBrowserTelemetryFromSavedConfig(config) {
  if (typeof window === "undefined") return;
  resetBrowserTelemetryConfigCache();
  window.__piclawObservabilityBrowserTelemetryBootstrapPromise = null;
  if (isBrowserTelemetryConfigEnabled(config)) {
    void bootstrapBrowserTelemetryIfEnabled();
  } else {
    disableAgentTelemetry();
  }
}

async function loadKeychainHas(name) {
  try {
    const r = await fetch("/agent/keychain");
    if (!r.ok) return false;
    const data = await r.json();
    return (data.entries || []).some((e) => e.name === name);
  } catch {
    return false;
  }
}

async function setKeychainSecret(name, secret) {
  try {
    const r = await fetch("/agent/keychain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, secret, type: "secret" }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function ObservabilitySettings() {
  if (!HAS_RUNTIME) return null;
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/config`);
      if (r.ok) setCfg(await r.json());
    } catch {
      setMsg("Failed to load config");
    }
    setHasKey(await loadKeychainHas(KEYCHAIN_ENTRY));
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (patch) => {
    setSaving(true);
    setMsg("");
    try {
      const r = await fetch(`${API}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (j.ok) {
        setCfg(j.config);
        syncBrowserTelemetryFromSavedConfig(j.config);
        setMsg("Saved");
        setTimeout(() => setMsg(""), 2000);
      } else {
        setMsg(j.error || "Save failed");
      }
    } catch {
      setMsg("Save failed");
    } finally {
      setSaving(false);
    }
  }, []);

  const saveConnectionString = useCallback(async () => {
    const secret = keyInput.trim();
    if (!secret) return;
    setSaving(true);
    const ok = await setKeychainSecret(KEYCHAIN_ENTRY, secret);
    setSaving(false);
    if (ok) {
      setHasKey(true);
      setKeyInput("");
      await save({ appinsights_keychain: KEYCHAIN_ENTRY });
      setMsg("Connection string saved to keychain. Restart required.");
      setTimeout(() => setMsg(""), 5000);
    } else {
      setMsg("Failed to save connection string.");
    }
  }, [keyInput, save]);

  if (!cfg) return html`<div style="padding:1rem;color:var(--text-secondary)">Loading…</div>`;

  const S = { display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.4rem 0" };
  const L = { minWidth: "180px", color: "var(--text-secondary)", fontSize: "0.85rem" };
  const I = { flex: 1, padding: "4px 8px", background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "4px", fontSize: "0.85rem" };
  const IM = { ...I, fontFamily: "var(--font-mono, monospace)", fontSize: "0.82rem" };
  const H = { margin: "1.2rem 0 0.4rem", fontSize: "0.9rem", color: "var(--text-primary)", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.3rem" };
  const hint = (t) => html`<div style=${{ fontSize: "0.73rem", color: "var(--text-secondary)", margin: "-0.15rem 0 0.4rem 188px" }}>${t}</div>`;

  const check = (label, key) => html`
    <label style=${S}><span style=${L}>${label}</span>
      <input type="checkbox" checked=${cfg[key]} onChange=${(e) => save({ [key]: e.target.checked })} disabled=${saving} />
    </label>`;

  const text = (label, key, placeholder) => html`
    <label style=${S}><span style=${L}>${label}</span>
      <input type="text" value=${cfg[key] ?? ""} style=${I} placeholder=${placeholder || ""}
        onBlur=${(e) => { if (e.target.value !== (cfg[key] ?? "")) save({ [key]: e.target.value }); }}
        onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }} disabled=${saving} />
    </label>`;

  const num = (label, key, placeholder) => html`
    <label style=${S}><span style=${L}>${label}</span>
      <input type="text" inputmode="numeric" value=${cfg[key] ?? ""} style=${{ ...I, maxWidth: "100px" }} placeholder=${placeholder || ""}
        onBlur=${(e) => { const v = Number(e.target.value); if (!isNaN(v) && v !== cfg[key]) save({ [key]: v }); }}
        onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }} disabled=${saving} />
    </label>`;

  return html`
    <div style="padding:0.5rem 0;">
      <h4 style=${H}>General</h4>
      ${check("Enabled", "enabled")}
      ${text("Instance name", "instance_name", hostname())}
      ${hint("Identifies this piclaw instance in App Insights (cloud_RoleInstance). Blank = hostname.")}

      <h4 style=${H}>Azure Application Insights</h4>
      ${check("App Insights enabled", "appinsights_enabled")}
      <div style=${S}>
        <span style=${L}>Connection string</span>
        <input type="password" value=${keyInput} style=${IM}
          placeholder=${hasKey ? "••••••• (stored in keychain)" : "InstrumentationKey=...;IngestionEndpoint=..."}
          onInput=${(e) => setKeyInput(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") saveConnectionString(); }}
          disabled=${saving} />
        <button style="padding:4px 10px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:0.82rem"
          onClick=${saveConnectionString} disabled=${!keyInput.trim() || saving}>Save</button>
        ${hasKey
          ? html`<span style="font-size:0.72rem;color:var(--accent-color,#2563eb);font-weight:600" title="Key in keychain">✓</span>`
          : html`<span style="font-size:0.72rem;color:var(--danger-color,#dc2626);font-weight:600" title="No key">✗</span>`
        }
      </div>
      ${hint("Saved to keychain as " + KEYCHAIN_ENTRY + ". Restart required after changing.")}
      ${check("Live Metrics Stream", "appinsights_live_metrics")}
      ${hint("Real-time telemetry in the Azure portal (QuickPulse).")}
      ${check("Standard metrics", "appinsights_standard_metrics")}
      ${num("Sampling ratio", "appinsights_sampling_ratio", "1")}
      ${hint("0–1. 1 = send all traces. 0.5 = sample 50%.")}
      ${check("Browser agent telemetry", "appinsights_browser_enabled")}
      ${hint("Off by default. When explicitly enabled, loads the App Insights browser SDK and wraps fetch/EventSource to translate agent UI activity into custom events keyed by chat JID.")}

      <h4 style=${H}>Graphite (Carbon plaintext)</h4>
      ${check("Graphite enabled", "graphite_enabled")}
      ${text("Host", "graphite_host", "192.168.1.250")}
      ${num("Port", "graphite_port", "2003")}
      ${text("Metric prefix", "graphite_prefix", "piclaw")}

      ${msg && html`<div style=${{ marginTop: "0.75rem", fontSize: "0.8rem", color: msg.includes("failed") || msg.includes("Failed") ? "var(--danger-color)" : "var(--accent-color)" }}>${msg}</div>`}
    </div>`;
}

function hostname() {
  try { return location?.hostname || ""; } catch { return ""; }
}

let observabilityPaneRegistered = false;

function registerObservabilitySettingsPane() {
  if (!HAS_RUNTIME || observabilityPaneRegistered) return observabilityPaneRegistered;
  let reg, notify;
  const r = globalThis.__piclawSettingsPaneRegistry;
  if (r) { reg = r.registerSettingsPane; notify = r.notifySettingsPanesChanged; }
  if (!reg && globalThis.__piclaw_web?.registerSettingsPane) {
    reg = globalThis.__piclaw_web.registerSettingsPane;
    notify = () => globalThis.dispatchEvent?.(new CustomEvent("piclaw:settings-panes-changed"));
  }
  if (!reg) return false;
  reg({ id: "observability", label: "Observability", icon: ICON, component: ObservabilitySettings, order: 170 });
  notify?.();
  observabilityPaneRegistered = true;
  return true;
}

function scheduleObservabilitySettingsPaneRegistration() {
  if (!HAS_RUNTIME || observabilityPaneRegistered) return;
  const attempt = () => {
    try {
      registerObservabilitySettingsPane();
    } catch {}
  };
  attempt();
  try { queueMicrotask(attempt); } catch {}
  try { setTimeout(attempt, 0); } catch {}
  try { setTimeout(attempt, 250); } catch {}
  try { setTimeout(attempt, 1000); } catch {}
  try { globalThis.requestAnimationFrame?.(() => attempt()); } catch {}
  try { globalThis.addEventListener?.("load", attempt, { once: true }); } catch {}
}

try {
  void bootstrapBrowserTelemetryIfEnabled();
} catch {}

try {
  scheduleObservabilitySettingsPaneRegistration();
} catch {}
