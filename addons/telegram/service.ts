/**
 * service.ts — Process-wide Telegram channel service.
 *
 * Owned by the startup runtime entry (runtime.ts), not by agent sessions:
 * polling starts at boot when enabled, survives individual session shutdowns
 * and stops through the Piclaw lifecycle API.
 *
 * Inbound dispatch requires an injected host provenance capability. The current
 * runtime has none, so it only sends an unavailable notice. Claims never use text.
 * Only one Telegram reply obligation is open at a time.
 */

/// <reference path="./grammy.d.ts" />

import { evaluateUpdate, isDedicatedChatJid, parseAllowedUserIds } from "./gate.js";
import { isRecoverableTelegramNetworkError } from "./telegram-network-errors.js";
import { resolveTelegramLongPollTimeoutSeconds } from "./telegram-request-timeouts.js";

export const ADDON_ID = "telegram";
export const BOT_TOKEN_KEYCHAIN = "telegram/bot-token";
const SETTINGS_KEY = "settings";
const SERVICE_KEY = Symbol.for("piclaw.addon.telegram.service");
const TELEGRAM_MESSAGE_LIMIT = 4096;
// An unclaimed message was never picked up by a run; a claimed one may still be recovering.
const UNCLAIMED_TTL_MS = 30 * 60 * 1000;
const CLAIMED_TTL_MS = 3 * 60 * 60 * 1000;
// After a failed attempt Piclaw may re-prompt with a neutral continuation; wait before giving up.
const FAILURE_GRACE_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 30_000;
const SEND_ATTEMPTS = 4;
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;
export const NOTICES = {
  start: "Connected to Piclaw. Send a plain text message.",
  command: "Commands (/, !) and @mentions are not available over Telegram.",
  unsupported: "Only plain text messages are supported.",
  busy: "Still working on your previous message. Please wait for the reply.",
  failed: "Could not deliver your message to Piclaw.",
  unknown: "Message admission is uncertain. Check the target web chat; it will not be retried.",
  unavailable: "Agent access via Telegram is not available yet on this Piclaw version.",
  sendFailed: "The reply could not be delivered to Telegram. Check the target web chat.",
  terminal: "Telegram forwarding stopped. The reply to your message will not be forwarded; agent work may still continue in the web chat.",
  noText: "The agent finished without a text reply.",
  aborted: "The agent run was aborted.",
  runFailed: "The agent run failed. Check the target web chat for details.",
} as const;

export type TelegramSettings = {
  enabled: boolean;
  allowedUserIds: string[];
  targetChatJid: string;
  targetIncarnation: string;
  pollingTimeout: number;
};

const DEFAULT_SETTINGS: TelegramSettings = { enabled: false, allowedUserIds: [], targetChatJid: "", targetIncarnation: "", pollingTimeout: 30 };

export type TelegramApi = {
  getMe(signal?: AbortSignal): Promise<{ id: number; username?: string }>;
  getUpdates(params: { offset?: number; timeout?: number; allowed_updates?: string[] }, signal?: AbortSignal): Promise<unknown[]>;
  sendMessage(chatId: number, text: string, other?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  sendChatAction(chatId: number, action: "typing", other?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type KvStore = {
  get(addon: string, key: string, scope?: "chat" | "global", scopeKey?: string): JsonValue | undefined;
  set(addon: string, key: string, value: unknown, scope?: "chat" | "global", scopeKey?: string): void;
};

type RuntimeApi = {
  lifecycle?: { version: number; onShutdown(handler: () => void | Promise<void>): () => void };
};

type RuntimeInterop = {
  getExtensionKvStore?: () => KvStore;
  getKeychainEntry?: (name: string) => Promise<{ secret?: unknown }>;
  getChatJid?: (defaultValue?: string) => string;
};

export type Target = { chatJid: string; incarnation: string };
export type HostReference = { addonId: string; intentId: string };
export type ToolContext = { chatJid?: string; chatIncarnation?: string; reference?: HostReference };
/** Host-bound provenance; the host must recheck lifetime and signal at queue admission. */
export type HostIngress = {
  resolveTarget(target: Target, signal: AbortSignal): Promise<Target | null>;
  enqueue(request: { target: Target; content: string; reference: HostReference }, signal: AbortSignal): Promise<{ status: "accepted"; chatJid: string; incarnation: string }>;
};
export type SettingsContext = {
  listTargets(): Promise<Array<Target & { label: string }>>;
  resolveTarget(target: Target): Promise<Target | null>;
};

export type TelegramServiceDeps = {
  ingress: HostIngress | null;
  runtime: () => RuntimeApi | undefined;
  interop: () => RuntimeInterop | undefined;
  env: Record<string, string | undefined>;
  createApi: (token: string) => Promise<TelegramApi>;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  setTimer: (ms: number, run: () => void) => () => void;
  log: { info(message: string): void; warn(message: string): void };
};

type Pending = { runId: number; intentId: string; chatId: number; createdAt: number; claimedAt: number | null; delivering: boolean; cancelFailureTimer?: () => void };
type ActiveRun = { ingress: AbortController; delivery: AbortController; generation: number; closing: boolean; failed: boolean; sends: Set<Promise<boolean>>; api: TelegramApi; loop: Promise<void>; settings: TelegramSettings; token: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 5 && value <= 120;
}

/** Parses a settings payload; returns an error string for anything invalid. */
export function parseSettings(value: unknown, base: TelegramSettings = DEFAULT_SETTINGS): TelegramSettings | string {
  if (!isRecord(value)) return "Settings must be an object.";
  const next = { ...base };
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") return "enabled must be a boolean.";
    next.enabled = value.enabled;
  }
  if (value.allowedUserIds !== undefined) {
    const ids = parseAllowedUserIds(value.allowedUserIds);
    if (!ids) return "allowedUserIds must contain numeric Telegram user IDs.";
    next.allowedUserIds = ids;
  }
  if (value.targetChatJid !== undefined) {
    const jid = typeof value.targetChatJid === "string" ? value.targetChatJid.trim() : null;
    if (jid === null || (jid !== "" && !isDedicatedChatJid(jid))) return "targetChatJid must be a dedicated web chat (not web:default).";
    next.targetChatJid = jid;
  }
  if (value.targetIncarnation !== undefined) {
    if (typeof value.targetIncarnation !== "string") return "targetIncarnation must be a string.";
    next.targetIncarnation = value.targetIncarnation.trim();
  }
  if (value.pollingTimeout !== undefined) {
    if (typeof value.pollingTimeout !== "number" || !Number.isFinite(value.pollingTimeout)) return "pollingTimeout must be a number.";
    next.pollingTimeout = Math.max(5, Math.min(120, Math.round(value.pollingTimeout)));
  }
  return next;
}

/** Splits text into Telegram-sized chunks without breaking surrogate pairs. */
export function splitMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let end = rest.lastIndexOf("\n", limit);
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1] ?? "")) end--;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Drops <internal> blocks fail-closed: nesting is counted and an unclosed tag hides the rest. */
export function stripInternal(text: string): string {
  let result = "";
  let depth = 0;
  for (let index = 0; index < text.length;) {
    if (text.startsWith("<internal>", index)) { depth++; index += 10; continue; }
    if (text.startsWith("</internal>", index)) { if (depth > 0) depth--; index += 11; continue; }
    if (depth === 0) result += text[index];
    index++;
  }
  return result.trim();
}

function errorCode(error: unknown): number {
  const code = isRecord(error) ? error.error_code : undefined;
  return typeof code === "number" ? code : 0;
}

function retryAfterMs(error: unknown): number {
  const parameters = isRecord(error) && isRecord(error.parameters) ? error.parameters : undefined;
  const seconds = parameters?.retry_after;
  return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : 0;
}

function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5));
}

/** 401/404 mean the token is invalid or revoked; retrying cannot help. */
function isFatal(error: unknown): boolean {
  const code = errorCode(error);
  return code === 401 || code === 404;
}

export class TelegramService {
  status = "Disabled";
  connected = false;
  private active: ActiveRun | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  private nextRunId = 1;
  private nextOffset = 0;
  private botId: number | null = null;
  private generation = 0;
  private ingress = new AbortController();
  private lifecycleRegistered = false;
  private stopped = false;

  constructor(private readonly deps: TelegramServiceDeps) {}

  private kv(): KvStore | undefined {
    try { return this.deps.interop()?.getExtensionKvStore?.(); } catch { return undefined; }
  }

  readStoredSettings(): TelegramSettings {
    let raw: unknown;
    try { raw = this.kv()?.get(ADDON_ID, SETTINGS_KEY, "global"); } catch { raw = undefined; }
    const parsed = parseSettings(isRecord(raw) ? raw : {});
    return typeof parsed === "string" ? { ...DEFAULT_SETTINGS } : parsed;
  }

  /** Stored settings with environment overrides applied. */
  effectiveSettings(stored = this.readStoredSettings()): TelegramSettings {
    const env = this.deps.env;
    const settings = { ...stored };
    if (env.PICLAW_TELEGRAM_ENABLED === "1") settings.enabled = true;
    const ids = env.PICLAW_TELEGRAM_ALLOWED_USER_IDS !== undefined ? parseAllowedUserIds(env.PICLAW_TELEGRAM_ALLOWED_USER_IDS) : undefined;
    if (ids !== undefined) settings.allowedUserIds = ids ?? [];
    const target = env.PICLAW_TELEGRAM_TARGET_CHAT_JID?.trim();
    if (target !== undefined && target !== "") settings.targetChatJid = isDedicatedChatJid(target) ? target : "";
    const incarnation = env.PICLAW_TELEGRAM_TARGET_INCARNATION?.trim();
    if (incarnation !== undefined) settings.targetIncarnation = incarnation;
    const timeout = Number(env.PICLAW_TELEGRAM_POLLING_TIMEOUT);
    if (validTimeout(timeout)) settings.pollingTimeout = timeout;
    return settings;
  }

  /** Validate before committing and fencing; never retain a request context. */
  async saveSettings(payload: unknown, context?: SettingsContext | null): Promise<TelegramSettings> {
    const stored = this.readStoredSettings();
    const next = parseSettings(payload, stored);
    if (typeof next === "string") throw new Error(`Invalid Telegram settings: ${next}`);
    if (isRecord(payload) && payload.enabled === false && this.deps.env.PICLAW_TELEGRAM_ENABLED === "1") {
      throw new Error("The environment enables Telegram via PICLAW_TELEGRAM_ENABLED=1. Unset it before disabling Telegram in Settings.");
    }
    const previous = this.effectiveSettings(stored);
    const effectiveNext = this.effectiveSettings(next);
    const generation = this.generation;
    // Persist stored changes even when an environment override masks them.
    const sameSettings = JSON.stringify(stored) === JSON.stringify(next)
      && JSON.stringify(previous) === JSON.stringify(effectiveNext);
    const unchanged = sameSettings && (!effectiveNext.enabled || (
      await this.resolveToken() === this.active?.token && this.active !== null
      && !this.active.failed && this.live(this.active)
    ));
    if (unchanged) return next;
    const disable = previous.enabled && !effectiveNext.enabled;
    if (!context) throw new Error("Verified local context unavailable; Telegram settings were not saved.");
    if (effectiveNext.enabled) {
      if (!effectiveNext.targetIncarnation) throw new Error("Select a current target chat lifetime.");
      const target = await context.resolveTarget({ chatJid: effectiveNext.targetChatJid, incarnation: effectiveNext.targetIncarnation });
      if (!target || target.chatJid !== effectiveNext.targetChatJid || target.incarnation !== effectiveNext.targetIncarnation) throw new Error("The selected target chat is stale or unavailable.");
    }
    if (generation !== this.generation) throw new Error("Telegram lifecycle changed while validating settings; settings were not saved.");
    const kv = this.kv();
    if (!kv) throw new Error("Telegram settings storage is unavailable.");
    if (this.pending && !disable) throw new Error("Telegram has an open reply obligation. Wait for delivery or disable the channel first.");
    // Both steps are synchronous: a failed write leaves ingress untouched, and
    // no admission can interleave between a successful commit and its fence.
    kv.set(ADDON_ID, SETTINGS_KEY, { ...next }, "global");
    this.fenceIngress();
    if (disable) await this.stop();
    else await this.reload();
    return next;
  }

  /** Token lookup order: environment, Piclaw keychain, legacy extension KV. */
  async resolveToken(): Promise<string> {
    const env = this.deps.env;
    const fromEnv = env.TELEGRAM_BOT_TOKEN?.trim() || env.PICLAW_TELEGRAM_BOT_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    const interop = this.deps.interop();
    try {
      const entry = await interop?.getKeychainEntry?.(BOT_TOKEN_KEYCHAIN);
      if (typeof entry?.secret === "string" && entry.secret.trim()) return entry.secret.trim();
    } catch { /* missing entry: fall through */ }
    try {
      const legacy = this.kv()?.get(ADDON_ID, "botToken");
      if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
    } catch { /* ignore */ }
    return "";
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.serial.then(run);
    this.serial = next.catch(() => {});
    return next;
  }

  private redact(message: string, token: string): string {
    return token ? message.split(token).join("<redacted>") : message;
  }

  private fenceIngress(): number {
    this.generation++;
    this.ingress.abort();
    this.active?.ingress.abort();
    this.ingress = new AbortController();
    return this.generation;
  }

  private live(run: ActiveRun): boolean {
    return run.generation === this.generation && !run.ingress.signal.aborted && !this.stopped;
  }

  /** A queued start cannot outlive a synchronous lifecycle fence. */
  start(): Promise<void> {
    const generation = this.generation;
    return this.serialized(() => this.startNow(generation));
  }

  reload(): Promise<void> {
    if (this.pending) return Promise.reject(new Error("Telegram has an open reply obligation. Disable the channel first."));
    const generation = this.fenceIngress();
    return this.serialized(async () => {
      await this.stopNow();
      await this.startNow(generation);
    });
  }

  stop(): Promise<void> {
    this.fenceIngress();
    if (this.active) this.active.closing = true;
    return this.serialized(() => this.stopNow());
  }

  private async startNow(generation: number): Promise<void> {
    const signal = this.ingress.signal;
    const current = () => generation === this.generation && !signal.aborted && !this.stopped;
    if (!current() || this.active) return;
    const runtime = this.deps.runtime();
    if (runtime?.lifecycle?.version !== 1) {
      this.status = "Inactive: this Piclaw version lacks the add-on runtime API";
      return;
    }
    if (!this.lifecycleRegistered) {
      this.lifecycleRegistered = true;
      runtime.lifecycle.onShutdown(async () => {
        this.stopped = true;
        await this.stop();
      });
    }
    const settings = this.effectiveSettings();
    if (!settings.enabled) { this.status = "Disabled"; return; }
    if (!settings.allowedUserIds.length) { this.status = "Inactive: no allowed Telegram user IDs"; return; }
    if (!isDedicatedChatJid(settings.targetChatJid) || !settings.targetIncarnation) { this.status = "Inactive: no dedicated target chat lifetime"; return; }
    const token = await this.resolveToken();
    if (!current()) return;
    if (!token) { this.status = "Inactive: bot token missing"; return; }
    let api: TelegramApi;
    try {
      api = await this.deps.createApi(token);
    } catch {
      if (current()) this.status = "Error: Telegram client unavailable";
      return;
    }
    if (!current()) return;
    this.status = "Connecting";
    const run: ActiveRun = { ingress: this.ingress, delivery: new AbortController(), generation, closing: false, failed: false, sends: new Set(), api, settings, token, loop: Promise.resolve() };
    this.active = run;
    run.loop = this.runLoop(run).finally(() => {
      if (run.failed && this.active === run) {
        this.active = null;
        if (this.ingress === run.ingress) this.ingress = new AbortController();
        // The rejected token cannot deliver a reply or notice; never leave an obligation stuck.
        if (this.pending) {
          this.deps.log.warn("[telegram] Dropping the open reply obligation: Telegram rejected the bot token");
          this.clearPending();
        }
        run.delivery.abort();
      }
    });
  }

  /** Connects (retrying transient failures) and then long-polls until aborted. */
  private async runLoop(run: ActiveRun): Promise<void> {
    const signal = run.ingress.signal;
    for (let failures = 1; !signal.aborted; failures++) {
      try {
        const me = await run.api.getMe(signal);
        if (!this.live(run)) return;
        if (this.botId !== me.id) { this.botId = me.id; this.nextOffset = 0; }
        this.deps.log.info(`[telegram] Connected as bot ${me.id}`);
        break;
      } catch (error) {
        if (signal.aborted) return;
        if (this.failFatal(run, error)) return;
        this.status = "Retrying: could not connect to Telegram";
        this.deps.log.warn(`[telegram] Connect failed: ${this.redact(String((error as Error)?.message ?? error), run.token)}`);
        await this.deps.sleep(backoffMs(failures), signal);
      }
    }
    if (signal.aborted) return;
    this.connected = true;
    this.status = "Connected";
    await this.pollLoop(run, Math.floor(this.deps.now() / 1000));
  }

  private failFatal(run: ActiveRun, error: unknown): boolean {
    if (!isFatal(error)) return false;
    this.status = "Error: Telegram rejected the bot token";
    this.connected = false;
    run.failed = true;
    run.ingress.abort();
    return true;
  }

  private async stopNow(): Promise<void> {
    const run = this.active;
    this.connected = false;
    if (!run) return;
    run.closing = true;
    run.ingress.abort();
    await run.loop.catch(() => {});
    await Promise.allSettled([...run.sends]);
    if (this.pending) {
      await this.send(run, this.pending.chatId, NOTICES.terminal);
      this.clearPending();
    }
    run.delivery.abort();
    if (this.active === run) this.active = null;
    if (!this.stopped) this.status = "Stopped";
  }

  private async pollLoop(run: ActiveRun, activatedAt: number): Promise<void> {
    const allowed = new Set(run.settings.allowedUserIds);
    const timeout = resolveTelegramLongPollTimeoutSeconds(run.settings.pollingTimeout);
    let failures = 0;
    while (this.live(run)) {
      let updates: unknown[];
      try {
        updates = await run.api.getUpdates({ offset: this.nextOffset || undefined, timeout, allowed_updates: ["message"] }, run.ingress.signal);
      } catch (error) {
        if (run.ingress.signal.aborted) break;
        if (this.failFatal(run, error)) break;
        const code = errorCode(error);
        failures++;
        this.connected = false;
        this.status = code === 409 ? "Retrying: another client is polling this bot" : "Retrying: Telegram unreachable";
        if (!code && !isRecoverableTelegramNetworkError(error)) {
          this.deps.log.warn(`[telegram] Polling error: ${this.redact(String((error as Error)?.message ?? error), run.token)}`);
        }
        // Honour Telegram's full retry_after; the wait ends early on stop.
        await this.deps.sleep(retryAfterMs(error) || backoffMs(failures), run.ingress.signal);
        continue;
      }
      if (!this.live(run)) break;
      failures = 0;
      this.connected = true;
      this.status = "Connected";
      for (const update of Array.isArray(updates) ? updates : []) {
        if (!this.live(run)) break;
        const updateId = isRecord(update) ? update.update_id : undefined;
        if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0 || !Number.isSafeInteger(updateId + 1) || updateId < this.nextOffset) continue;
        this.nextOffset = updateId + 1;
        await this.handleUpdate(run, update, allowed, activatedAt);
      }
    }
    this.connected = false;
    if (this.status === "Connected") this.status = "Disconnected";
  }

  private async handleUpdate(run: ActiveRun, update: unknown, allowed: ReadonlySet<string>, activatedAt: number): Promise<void> {
    const decision = evaluateUpdate(update, allowed, activatedAt);
    if (decision.kind === "ignore") return;
    if (decision.kind !== "accept") {
      const notice = decision.kind === "start" && !this.deps.ingress ? NOTICES.unavailable : NOTICES[decision.kind];
      await this.send(run, decision.chatId, notice, false);
      return;
    }
    if (!this.deps.ingress) {
      await this.send(run, decision.chatId, NOTICES.unavailable, false);
      return;
    }
    const now = this.deps.now();
    if (this.pending) {
      if (!this.isExpired(this.pending, now) || this.pending.delivering) {
        await this.send(run, decision.chatId, NOTICES.busy, false);
        return;
      }
      await this.deliverReply(run, this.pending, NOTICES.runFailed);
      if (!this.live(run)) return;
    }
    const runId = this.nextRunId++;
    const pending: Pending = { runId, intentId: crypto.randomUUID(), chatId: decision.chatId, createdAt: now, claimedAt: null, delivering: false };
    this.pending = pending;
    const target = { chatJid: run.settings.targetChatJid, incarnation: run.settings.targetIncarnation };
    let attempted = false;
    try {
      const resolved = await this.deps.ingress.resolveTarget(target, run.ingress.signal);
      if (!this.live(run)) {
        if (!run.closing) await this.deliverReply(run, pending, NOTICES.failed);
        return;
      }
      if (!resolved || resolved.chatJid !== target.chatJid || resolved.incarnation !== target.incarnation) throw new Error("target chat lifetime not found");
      attempted = true;
      const result = await this.deps.ingress.enqueue({ target, content: decision.text, reference: { addonId: ADDON_ID, intentId: pending.intentId } }, run.ingress.signal);
      if (result.status !== "accepted" || result.chatJid !== target.chatJid || result.incarnation !== target.incarnation) throw new Error("unverified receipt");
      // A verified receipt remains an obligation even if the ingress fence won.
      if (!this.live(run)) return;
    } catch (error) {
      if (run.closing) return;
      // No automatic retries, including uncertain admission outcomes.
      const rejected = isRecord(error) && error.delivery === "rejected";
      await this.deliverReply(run, pending, attempted && !rejected ? NOTICES.unknown : NOTICES.failed);
      return;
    }
    if (this.live(run)) {
      const typing = run.api.sendChatAction(decision.chatId, "typing", undefined, run.delivery.signal).then(() => true, () => false);
      run.sends.add(typing);
      void typing.then(() => run.sends.delete(typing));
    }
  }

  /**
   * Local gate notices are sent once; replies and terminal notices retry rate
   * limits, server errors and transient network failures, honouring retry_after.
   */
  private send(run: ActiveRun, chatId: number, text: string, retry = true, reply = false): Promise<boolean> {
    const delivery = (async () => {
      for (const chunk of splitMessage(text)) {
        if (reply && run.closing) return false;
        if (!(await this.sendChunk(run, chatId, chunk, retry ? SEND_ATTEMPTS : 1, reply))) return false;
      }
      return true;
    })();
    run.sends.add(delivery);
    void delivery.then(() => run.sends.delete(delivery), () => run.sends.delete(delivery));
    return delivery;
  }

  private async sendChunk(run: ActiveRun, chatId: number, chunk: string, attempts: number, reply: boolean): Promise<boolean> {
    const signal = run.delivery.signal;
    for (let attempt = 1; !signal.aborted && !(reply && run.closing); attempt++) {
      try {
        await run.api.sendMessage(chatId, chunk, { link_preview_options: { is_disabled: true } }, signal);
        return true;
      } catch (error) {
        const code = errorCode(error);
        const retryable = code === 429 || code >= 500 || (!code && isRecoverableTelegramNetworkError(error));
        const wait = retryAfterMs(error) || backoffMs(attempt - 1);
        if (!retryable || attempt >= attempts || wait > MAX_RETRY_AFTER_MS || signal.aborted || (reply && run.closing)) {
          this.deps.log.warn(`[telegram] Send failed: ${this.redact(String((error as Error)?.message ?? error), run.token)}`);
          return false;
        }
        try { await this.deps.sleep(wait, signal); } catch { return false; }
      }
    }
    return false;
  }

  private async deliverReply(run: ActiveRun, pending: Pending, text: string): Promise<void> {
    if (pending.delivering) return;
    pending.cancelFailureTimer?.();
    pending.cancelFailureTimer = undefined;
    pending.delivering = true;
    const sent = await this.send(run, pending.chatId, text, true, true).catch(() => false);
    // Stop owns the terminal notice and clearing, even if a final chunk finished.
    if (run.closing) return;
    if (!sent) await this.send(run, pending.chatId, NOTICES.sendFailed, false);
    if (this.pending === pending) this.clearPending();
  }

  private isExpired(pending: Pending, now: number): boolean {
    return pending.claimedAt === null
      ? now - pending.createdAt >= UNCLAIMED_TTL_MS
      : now - pending.claimedAt >= CLAIMED_TTL_MS;
  }

  private clearPending(): void {
    this.pending?.cancelFailureTimer?.();
    this.pending = null;
  }

  private matches(run: ActiveRun, pending: Pending, context?: ToolContext | null): boolean {
    return context?.reference?.addonId === ADDON_ID && context.reference.intentId === pending.intentId
      && context.chatJid === run.settings.targetChatJid && context.chatIncarnation === run.settings.targetIncarnation;
  }

  /** Only host-bound reference and exact target lifetime can claim an intent. */
  claimRun(chatJid: string, context?: ToolContext | null): number | null {
    const run = this.active;
    const pending = this.pending;
    if (!run || !pending || run.closing || pending.delivering || pending.claimedAt !== null || chatJid !== run.settings.targetChatJid || !this.matches(run, pending, context)) return null;
    if (this.isExpired(pending, this.deps.now())) {
      void this.deliverReply(run, pending, NOTICES.runFailed);
      return null;
    }
    pending.claimedAt = this.deps.now();
    return pending.runId;
  }

  /** Recovery is eligible only with the same host-bound reference and lifetime. */
  continueRun(runId: number, context?: ToolContext | null): boolean {
    const run = this.active;
    const pending = this.pending;
    if (!run || run.closing || pending?.runId !== runId || !pending.cancelFailureTimer || !this.matches(run, pending, context)) return false;
    pending.cancelFailureTimer();
    pending.cancelFailureTimer = undefined;
    return true;
  }

  /**
   * Called when a claimed run settles. A successful or aborted run is answered
   * immediately; a failed attempt waits for a recovery continuation first.
   */
  async completeRun(runId: number, text: string | null, aborted: boolean): Promise<void> {
    const run = this.active;
    const pending = this.pending;
    if (!run || run.closing || !pending || pending.delivering || pending.runId !== runId) return;
    if (text === null && !aborted) {
      pending.cancelFailureTimer?.();
      pending.cancelFailureTimer = this.deps.setTimer(FAILURE_GRACE_MS, () => {
        if (this.pending !== pending || this.active !== run) return;
        void this.deliverReply(run, pending, NOTICES.runFailed);
      });
      return;
    }
    const reply = text === null ? "" : stripInternal(text);
    await this.deliverReply(run, pending, reply || (aborted ? NOTICES.aborted : NOTICES.noText));
  }

  async view(): Promise<Record<string, unknown>> {
    const settings = this.effectiveSettings();
    return {
      ...settings,
      connected: this.connected,
      status: this.status,
      botTokenConfigured: Boolean(await this.resolveToken()),
      botTokenKeychain: BOT_TOKEN_KEYCHAIN,
    };
  }
}

type PiclawHost = typeof globalThis & { __piclaw_runtime?: RuntimeApi; __piclawRuntimeInterop?: RuntimeInterop };

function defaultDeps(ingress: HostIngress | null): TelegramServiceDeps {
  const host = globalThis as PiclawHost;
  return {
    ingress,
    runtime: () => host.__piclaw_runtime,
    interop: () => host.__piclawRuntimeInterop,
    env: process.env,
    createApi: async (token) => {
      const mod = await import("grammy");
      // SAFETY: TelegramApi is the subset of grammY's Api used here; grammy.d.ts mirrors those signatures.
      return new mod.Api(token) as unknown as TelegramApi;
    },
    now: () => Date.now(),
    setTimer: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
      signal.addEventListener("abort", done, { once: true });
    }),
    log: { info: (message) => console.log(message), warn: (message) => console.warn(message) },
  };
}

/** One service per process, shared by the runtime entry and every pi session. */
export function getTelegramService(options: { ingress: HostIngress | null }): TelegramService {
  const host = globalThis as Record<symbol, TelegramService | undefined>;
  return (host[SERVICE_KEY] ??= new TelegramService(defaultDeps(options.ingress)));
}

export function peekTelegramService(): TelegramService | undefined {
  return (globalThis as Record<symbol, TelegramService | undefined>)[SERVICE_KEY];
}
