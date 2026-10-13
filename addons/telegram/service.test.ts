import { afterEach, expect, test } from "bun:test";
import registerExtension from "./index.js";
import { NOTICES, TelegramService, splitMessage, stripInternal } from "./service.js";
import type { HostIngress, SettingsContext, TelegramApi, TelegramServiceDeps, ToolContext } from "./service.js";

const OPERATOR = 111222333;
const TARGET = "web:telegram";
const INCARNATION = "branch-telegram";
const settingsContext: SettingsContext = {
  listTargets: async () => [{ chatJid: TARGET, incarnation: INCARNATION, label: "telegram" }],
  resolveTarget: async (target) => target.chatJid === TARGET && target.incarnation === INCARNATION ? target : null,
};
const SERVICE_KEY = Symbol.for("piclaw.addon.telegram.service");
const START = 1_700_000_000_000;
const CONTINUATION = "Continue the current task from persisted state without repeating completed work.";

class FakeApi implements TelegramApi {
  batches: unknown[][] = [];
  sent: Array<[number, string]> = [];
  offsets: Array<number | undefined> = [];
  getMeErrors: unknown[] = [];
  sendErrors: unknown[] = [];
  polls = 0;
  getMeCalls = 0;
  botId = 42;
  sendHook?: (chatId: number, text: string, signal?: AbortSignal) => Promise<void>;
  sendSignals: AbortSignal[] = [];
  wake?: () => void;
  async getMe() {
    this.getMeCalls++;
    const error = this.getMeErrors.shift();
    if (error) throw error;
    return { id: this.botId };
  }
  async getUpdates(params: { offset?: number }, signal?: AbortSignal) {
    this.polls++;
    this.offsets.push(params.offset);
    const batch = this.batches.shift();
    if (batch) return batch;
    await new Promise<void>((resolve) => {
      this.wake = resolve;
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return this.batches.shift() ?? [];
  }
  /** Delivers a batch to a long poll that is already waiting. */
  push(batch: unknown[]) {
    this.batches.push(batch);
    this.wake?.();
  }
  async sendMessage(chatId: number, text: string, _other?: Record<string, unknown>, signal?: AbortSignal) {
    if (signal) this.sendSignals.push(signal);
    await this.sendHook?.(chatId, text, signal);
    const error = this.sendErrors.shift();
    if (error) throw error;
    this.sent.push([chatId, text]);
    return {};
  }
  async sendChatAction() { return true; }
}

type HarnessOptions = {
  settings?: Record<string, unknown> | null;
  env?: Record<string, string>;
  keychain?: string | null;
  knownChats?: string[];
  runtimeApi?: boolean;
  ingress?: HostIngress | null;
  sleep?: TelegramServiceDeps["sleep"];
  createApi?: TelegramServiceDeps["createApi"];
};

function harness(options: HarnessOptions = {}) {
  const kv = new Map<string, unknown>();
  if (options.settings !== null) {
    kv.set("global:settings", options.settings ?? { enabled: true, allowedUserIds: [String(OPERATOR)], targetChatJid: TARGET, targetIncarnation: INCARNATION, pollingTimeout: 30 });
  }
  const api = new FakeApi();
  const enqueued: Array<{ target: { chatJid: string; incarnation: string }; content: string; reference: { addonId: string; intentId: string } }> = [];
  const shutdownHandlers: Array<() => void | Promise<void>> = [];
  const tokens: string[] = [];
  const logs: string[] = [];
  const timers: Array<() => void> = [];
  const clock = { now: START };
  let chatJid = TARGET;
  const known = new Set(options.knownChats ?? [TARGET]);
  const runtime = {
    lifecycle: { version: 1, onShutdown: (handler: () => void | Promise<void>) => { shutdownHandlers.push(handler); return () => {}; } },

  };
  const interop = {
    getExtensionKvStore: () => ({
      get: (_addon: string, key: string, scope?: string) => kv.get(`${scope ?? "chat"}:${key}`) as never,
      set: (_addon: string, key: string, value: unknown, scope?: string) => { kv.set(`${scope ?? "chat"}:${key}`, value); },
    }),
    getKeychainEntry: async (name: string) => {
      if (name !== "telegram/bot-token" || options.keychain === null) throw new Error(`Keychain entry not found: ${name}`);
      return { secret: options.keychain ?? "123:keychain-token" };
    },
    getChatJid: () => chatJid,
  };
  let context: ToolContext | null = null;
  const ingress: HostIngress = {
    resolveTarget: async (target) => known.has(target.chatJid) ? target : null,
    enqueue: async (request) => { enqueued.push(request); return { status: "accepted", ...request.target }; },
  };
  const service = new TelegramService({
    ingress: options.ingress === undefined ? ingress : options.ingress,
    runtime: () => (options.runtimeApi === false ? undefined : runtime),
    interop: () => interop,
    env: options.env ?? {},
    createApi: options.createApi ?? (async (token) => { tokens.push(token); return api; }),
    now: () => clock.now,
    sleep: options.sleep ?? (async () => {}),
    setTimer: (_ms, run) => { timers.push(run); return () => { const index = timers.indexOf(run); if (index >= 0) timers.splice(index, 1); }; },
    log: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
  });
  (globalThis as Record<symbol, unknown>)[SERVICE_KEY] = service;
  (globalThis as Record<string, unknown>).__piclawRuntimeInterop = interop;
  (globalThis as Record<string, unknown>).__piclaw_runtime = { localContext: { version: 1, getToolContext: () => context } };
  return { service, api, kv, enqueued, ingress, logs, interop,
    setContext: (value: ToolContext | null) => { context = value; },
    authorize: () => { context = { chatJid: TARGET, chatIncarnation: INCARNATION, reference: enqueued.at(-1)!.reference }; }, shutdownHandlers, tokens, timers, clock, setChat: (jid: string) => { chatJid = jid; } };
}

function textUpdate(updateId: number, text: string, fromId = OPERATOR) {
  return {
    update_id: updateId,
    message: { message_id: updateId, date: START / 1000 + 1, from: { id: fromId, is_bot: false }, chat: { id: fromId, type: "private" }, text },
  };
}

/** Minimal pi stand-in: collects handlers so tests can emit session events. */
function fakePi() {
  const handlers = new Map<string, Array<(event: any) => unknown>>();
  const pi = { on: (name: string, handler: (event: any) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
  registerExtension(pi as never);
  return {
    handlers,
    emit: async (name: string, event: Record<string, unknown> = {}) => { for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }); },
  };
}

async function settle(condition: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const prompt = (text: string) => `Channel: web\n\nChat: ${TARGET}\n\nuser @ 2026-10-12T10:00:00Z:\n${text.split("\n").map((line) => `  ${line}`).join("\n")}`;
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });

let active: TelegramService | null = null;
afterEach(async () => {
  await active?.stop();
  active = null;
  delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
  delete (globalThis as Record<string, unknown>).__piclawRuntimeInterop;
  delete (globalThis as Record<string, unknown>).__piclaw_runtime;
});

test("boot restore starts polling from saved settings without any agent session", async () => {
  const h = harness();
  active = h.service;
  await h.service.start();
  await settle(() => h.api.polls > 0, "first poll");
  expect(h.service.connected).toBeTrue();
  expect(h.tokens).toEqual(["123:keychain-token"]);
  expect(h.shutdownHandlers).toHaveLength(1);
});

test("allowlisted messages are queued into the dedicated chat through the runtime API", async () => {
  const h = harness();
  active = h.service;
  h.api.batches.push([textUpdate(1, "hello")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");
  expect(h.enqueued[0]).toMatchObject({ target: { chatJid: TARGET, incarnation: INCARNATION }, content: "hello", reference: { addonId: "telegram" } });
});

test("unauthorized senders are ignored without a reply", async () => {
  const h = harness();
  active = h.service;
  h.api.batches.push([textUpdate(1, "let me in", 999), { update_id: 2, edited_message: textUpdate(2, "edit").message }]);
  await h.service.start();
  await settle(() => h.api.polls > 1, "second poll");
  expect(h.enqueued).toEqual([]);
  expect(h.api.sent).toEqual([]);
});

test.each([
  ["no allowlist", { settings: { enabled: true, allowedUserIds: [], targetChatJid: TARGET } }, "Inactive: no allowed Telegram user IDs"],
  ["no target chat", { settings: { enabled: true, allowedUserIds: [String(OPERATOR)], targetChatJid: "" } }, "Inactive: no dedicated target chat lifetime"],
  ["web:default as target", { settings: { enabled: true, allowedUserIds: [String(OPERATOR)], targetChatJid: "web:default" } }, "Disabled"],
  ["missing bot token", { keychain: null }, "Inactive: bot token missing"],
  ["disabled", { settings: { enabled: false, allowedUserIds: [String(OPERATOR)], targetChatJid: TARGET } }, "Disabled"],
  ["no runtime API", { runtimeApi: false }, "Inactive: this Piclaw version lacks the add-on runtime API"],
])("fails closed with %s", async (_label, options, status) => {
  const h = harness(options as HarnessOptions);
  active = h.service;
  await h.service.start();
  expect(h.tokens).toEqual([]);
  expect(h.api.polls).toBe(0);
  expect(h.service.status).toBe(status);
});

test("environment token takes precedence over the keychain", async () => {
  const h = harness({ env: { TELEGRAM_BOT_TOKEN: "999:env-token" } });
  active = h.service;
  await h.service.start();
  expect(h.tokens).toEqual(["999:env-token"]);
});

test("environment-only enablement rejects Settings disable without changing polling or status", async () => {
  const h = harness({ settings: { enabled: false }, env: {
    PICLAW_TELEGRAM_ENABLED: "1",
    PICLAW_TELEGRAM_ALLOWED_USER_IDS: String(OPERATOR),
    PICLAW_TELEGRAM_TARGET_CHAT_JID: TARGET,
    PICLAW_TELEGRAM_TARGET_INCARNATION: INCARNATION,
  } });
  active = h.service;
  await h.service.start();
  await settle(() => h.api.polls === 1, "environment-enabled poll");
  const run = h.service["active"];
  const stored = h.service.readStoredSettings();
  await expect(h.service.saveSettings({ enabled: false }, settingsContext)).rejects.toThrow(
    "The environment enables Telegram via PICLAW_TELEGRAM_ENABLED=1. Unset it before disabling Telegram in Settings.",
  );
  expect(h.service.readStoredSettings()).toEqual(stored);
  expect(h.service["active"]).toBe(run);
  expect(run!.ingress.signal.aborted).toBeFalse();
  expect(await h.service.view()).toMatchObject({ enabled: true, connected: true, status: "Connected" });
});

test("environment-enabled no-op save preserves polling but applies keychain rotation", async () => {
  const options: HarnessOptions = { settings: { enabled: false }, keychain: "old:token", env: {
    PICLAW_TELEGRAM_ENABLED: "1",
    PICLAW_TELEGRAM_ALLOWED_USER_IDS: String(OPERATOR),
    PICLAW_TELEGRAM_TARGET_CHAT_JID: TARGET,
    PICLAW_TELEGRAM_TARGET_INCARNATION: INCARNATION,
  } };
  const h = harness(options);
  active = h.service;
  const rotated = new FakeApi();
  h.service["deps"].createApi = async (token) => {
    h.tokens.push(token);
    return token === "old:token" ? h.api : rotated;
  };
  await h.service.start();
  await settle(() => h.api.polls === 1, "environment-enabled poll");
  const run = h.service["active"];
  await h.service.saveSettings({});
  expect(h.service["active"]).toBe(run);
  expect(run!.ingress.signal.aborted).toBeFalse();
  expect(h.tokens).toEqual(["old:token"]);
  options.keychain = "new:token";
  await h.service.saveSettings({}, settingsContext);
  await settle(() => rotated.polls === 1, "rotated environment-enabled poll");
  expect(run!.ingress.signal.aborted).toBeTrue();
  expect(h.tokens).toEqual(["old:token", "new:token"]);
  expect(h.service.readStoredSettings().enabled).toBeFalse();
  expect(await h.service.view()).toMatchObject({ enabled: true, connected: true, status: "Connected" });
});

test("session shutdown leaves polling running; lifecycle shutdown stops it", async () => {
  const h = harness();
  active = h.service;
  const pi = fakePi();
  expect(pi.handlers.has("session_start")).toBeFalse();
  expect(pi.handlers.has("session_shutdown")).toBeFalse();
  await h.service.start();
  await settle(() => h.api.polls > 0, "first poll");
  await pi.emit("session_shutdown");
  expect(h.service.connected).toBeTrue();

  await h.shutdownHandlers[0]();
  expect(h.service.connected).toBeFalse();
  await h.service.start();
  expect(h.api.polls).toBe(1);
});

test("the settled reply of the claimed run goes back to the sender once", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "line one\nline two")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");

  h.authorize();
  await session.emit("before_agent_start", { prompt: prompt("line one\nline two") });
  await session.emit("agent_end", { messages: [assistant("", "error")] });
  await session.emit("agent_end", { messages: [assistant("Here you go.<internal>scratch <internal>nested</internal> still hidden</internal>")] });
  await session.emit("agent_settled", { aborted: false });
  await settle(() => h.api.sent.length === 1, "reply");
  expect(h.api.sent).toEqual([[OPERATOR, "Here you go."]]);

  await session.emit("agent_settled", { aborted: false });
  expect(h.api.sent).toHaveLength(1);
});

test("other runs in the target chat, side sessions and other chats are not mirrored", async () => {
  const h = harness();
  active = h.service;
  const main = fakePi();
  const side = fakePi();
  h.api.batches.push([textUpdate(1, "status please")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");

  await main.emit("before_agent_start", { prompt: prompt("an unrelated web message") });
  await main.emit("agent_end", { messages: [assistant("web reply")] });
  await main.emit("agent_settled");

  h.setChat("web:other");
  await side.emit("before_agent_start", { prompt: prompt("status please") });
  await side.emit("agent_settled");
  h.setChat(TARGET);

  h.authorize();
  await main.emit("before_agent_start", { prompt: prompt("status please") });
  await side.emit("before_agent_start", { prompt: prompt("status please") });
  await side.emit("agent_end", { messages: [assistant("side reply")] });
  await side.emit("agent_settled");
  await main.emit("agent_end", { messages: [assistant("all good")] });
  await main.emit("agent_settled");
  await settle(() => h.api.sent.length === 1, "reply");
  expect(h.api.sent).toEqual([[OPERATOR, "all good"]]);
});

test("a second message while one is in flight is refused", async () => {
  const h = harness();
  active = h.service;
  h.api.batches.push([textUpdate(1, "first"), textUpdate(2, "second")]);
  await h.service.start();
  await settle(() => h.api.sent.length === 1, "busy notice");
  expect(h.enqueued).toHaveLength(1);
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.busy]]);
});

test("commands are answered locally and never queued", async () => {
  const h = harness();
  active = h.service;
  h.api.batches.push([textUpdate(1, "/compact"), textUpdate(2, "/start")]);
  await h.service.start();
  await settle(() => h.api.sent.length === 2, "notices");
  expect(h.enqueued).toEqual([]);
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.command], [OPERATOR, NOTICES.start]]);
});

test.each([
  ["unavailable ingress", null, "Agent access via Telegram is not available yet on this Piclaw version."],
  ["supported ingress", undefined, "Connected to Piclaw. Send a plain text message."],
])("/start reports %s without queueing a message", async (_label, ingress, reply) => {
  const h = harness({ ingress });
  active = h.service;
  h.api.batches.push([textUpdate(1, "/start")]);
  await h.service.start();
  await settle(() => h.api.sent.length === 1, "/start notice");
  expect(h.api.sent).toEqual([[OPERATOR, reply]]);
  expect(h.enqueued).toEqual([]);
});

test("settings are validated, stored globally without secrets and applied on reload", async () => {
  const h = harness({ settings: null });
  active = h.service;
  await expect(h.service.saveSettings({ targetChatJid: "web:default" }, settingsContext)).rejects.toThrow();
  await expect(h.service.saveSettings({ allowedUserIds: "12,abc" }, settingsContext)).rejects.toThrow();
  await h.service.saveSettings({ enabled: true, allowedUserIds: `${OPERATOR}`, targetChatJid: TARGET, targetIncarnation: INCARNATION, pollingTimeout: 999, botToken: "must-not-be-stored" }, settingsContext);
  expect(h.kv.get("global:settings")).toEqual({ enabled: true, allowedUserIds: [String(OPERATOR)], targetChatJid: TARGET, targetIncarnation: INCARNATION, pollingTimeout: 120 });
  await settle(() => h.api.polls > 0, "poll after reload");
  expect(h.service.connected).toBeTrue();
});

test("recovery with the same host reference ignores prompt text", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "do the thing")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");

  h.authorize();
  await session.emit("before_agent_start", { prompt: prompt("do the thing") });
  await session.emit("agent_end", { messages: [assistant("", "error")] });
  await session.emit("agent_settled", { aborted: false });
  expect(h.api.sent).toEqual([]);
  expect(h.timers).toHaveLength(1);

  await session.emit("before_agent_start", { prompt: "An arbitrary non-continuation prompt." });
  expect(h.timers).toHaveLength(0);
  await session.emit("agent_end", { messages: [assistant("Done after recovery.")] });
  await session.emit("agent_settled", { aborted: false });
  await settle(() => h.api.sent.length === 1, "reply");
  expect(h.api.sent).toEqual([[OPERATOR, "Done after recovery."]]);
});

test("a web turn after a failed attempt is not treated as recovery", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "telegram task")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");
  h.authorize();
  await session.emit("before_agent_start", { prompt: prompt("telegram task") });
  await session.emit("agent_end", { messages: [assistant("", "error")] });
  await session.emit("agent_settled", { aborted: false });

  h.setContext(null);
  await session.emit("before_agent_start", { prompt: prompt("a web user typing in the same chat") });
  await session.emit("agent_end", { messages: [assistant("web-only reply")] });
  await session.emit("agent_settled", { aborted: false });
  expect(h.api.sent).toEqual([]);
  expect(h.timers).toHaveLength(1);
  h.timers.shift()!();
  await settle(() => h.api.sent.length === 1, "failure notice");
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.runFailed]]);
});

test("a failed run without recovery reports failure after the grace period and frees the channel", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "first")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");
  h.authorize();
  await session.emit("before_agent_start", { prompt: prompt("first") });
  await session.emit("agent_end", { messages: [assistant("", "error")] });
  await session.emit("agent_settled", { aborted: false });
  h.timers.shift()!();
  await settle(() => h.api.sent.length === 1, "failure notice");
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.runFailed]]);

  h.api.push([textUpdate(2, "second")]);
  await settle(() => h.enqueued.length === 2, "second enqueue");
});

test("a claimed run is not displaced by the unclaimed timeout", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "long task")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");
  h.authorize();
  await session.emit("before_agent_start", { prompt: prompt("long task") });
  h.clock.now += 45 * 60 * 1000;
  h.api.push([{ ...textUpdate(2, "another"), message: { ...textUpdate(2, "another").message, date: h.clock.now / 1000 } }]);
  await settle(() => h.api.sent.length === 1, "busy notice");
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.busy]]);
  await session.emit("agent_end", { messages: [assistant("finally")] });
  await session.emit("agent_settled", { aborted: false });
  await settle(() => h.api.sent.length === 2, "reply");
  expect(h.api.sent[1]).toEqual([OPERATOR, "finally"]);
  expect(h.enqueued).toHaveLength(1);
});

test("Telegram text equal to prompt metadata does not claim a foreign run", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "Channel: web")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue");
  await session.emit("before_agent_start", { prompt: prompt("an unrelated web message") });
  await session.emit("agent_end", { messages: [assistant("web reply")] });
  await session.emit("agent_settled", { aborted: false });
  expect(h.api.sent).toEqual([]);
});

test("transient failures while connecting and sending are retried", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.getMeErrors.push(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }));
  h.api.sendErrors.push({ error_code: 429, parameters: { retry_after: 240 }, message: "Too Many Requests" });
  h.api.batches.push([textUpdate(1, "hi")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "enqueue after reconnect");
  h.authorize();
  await session.emit("before_agent_start", { prompt: prompt("hi") });
  await session.emit("agent_end", { messages: [assistant("hello")] });
  await session.emit("agent_settled", { aborted: false });
  await settle(() => h.api.sent.length === 1, "reply after retry");
  expect(h.api.sent).toEqual([[OPERATOR, "hello"]]);
});

test("notices from the poll loop are not retried", async () => {
  const h = harness();
  active = h.service;
  h.api.sendErrors.push({ error_code: 429, parameters: { retry_after: 240 }, message: "Too Many Requests" });
  h.api.batches.push([textUpdate(1, "/start"), textUpdate(2, "/help")]);
  await h.service.start();
  await settle(() => h.api.sent.length === 1, "second notice");
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.command]]);
});

test("a rejected token stops the channel instead of retrying", async () => {
  const h = harness();
  active = h.service;
  h.api.getMeErrors.push({ error_code: 401, message: "Unauthorized" });
  await h.service.start();
  await settle(() => h.service.status === "Error: Telegram rejected the bot token", "fatal status");
  expect(h.api.polls).toBe(0);
});

test("same-bot reload and token rotation keep the update offset; bot change resets it", async () => {
  const h = harness();
  active = h.service;
  h.api.batches.push([textUpdate(500, "/start")]);
  await h.service.start();
  await settle(() => h.api.offsets.length === 2, "second poll");
  expect(h.api.offsets).toEqual([undefined, 501]);
  await h.service.reload();
  await settle(() => h.api.offsets.length === 3, "poll after reload");
  expect(h.api.offsets[2]).toBe(501);
  await h.service.stop();
  h.service["deps"].env.TELEGRAM_BOT_TOKEN = "rotated:token";
  await h.service.start();
  await settle(() => h.api.offsets.length === 4, "rotated poll");
  expect(h.api.offsets[3]).toBe(501);
  expect(h.tokens.at(-1)).toBe("rotated:token");
  await h.service.stop();
  h.api.botId = 43;
  await h.service.start();
  await settle(() => h.api.offsets.length === 5, "new bot poll");
  expect(h.api.offsets[4]).toBeUndefined();
});

test("helpers", () => {
  expect(stripInternal("visible<internal>hidden")).toBe("visible");
  expect(stripInternal("a<internal>x<internal>y</internal>z</internal>b")).toBe("ab");
  expect(splitMessage("x".repeat(5000)).map((chunk) => chunk.length)).toEqual([4096, 904]);
  expect(splitMessage(`${"a".repeat(4095)}😀`)).toEqual(["a".repeat(4095), "😀"]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function admit(h: ReturnType<typeof harness>, text = "task") {
  h.api.batches.push([textUpdate(1, text)]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "admission");
  h.authorize();
  const context: ToolContext = { chatJid: TARGET, chatIncarnation: INCARNATION, reference: h.enqueued[0].reference };
  const runId = h.service.claimRun(TARGET, context);
  expect(runId).not.toBeNull();
  return runId!;
}

test("null ingress sends an unavailable notice and never uses raw runtime enqueue", async () => {
  const h = harness({ ingress: null });
  active = h.service;
  let rawEnqueues = 0;
  h.service["deps"].runtime = () => ({ lifecycle: { version: 1, onShutdown: () => () => {} }, enqueueAgentMessage: () => { rawEnqueues++; } } as never);
  h.api.batches.push([textUpdate(1, "hello")]);
  await h.service.start();
  await settle(() => h.api.sent.length === 1, "unavailable notice");
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.unavailable]]);
  expect(rawEnqueues).toBe(0);
  expect(h.enqueued).toHaveLength(0);
});

test("identical body in unrelated runs and mismatched provenance cannot claim", async () => {
  const h = harness();
  active = h.service;
  h.api.batches.push([textUpdate(1, "identical body")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "admission");
  const foreign = fakePi();
  await foreign.emit("before_agent_start", { prompt: prompt("identical body"), reference: h.enqueued[0].reference });
  await foreign.emit("agent_end", { messages: [assistant("foreign reply")] });
  await foreign.emit("agent_settled");
  expect(h.api.sent).toEqual([]);
  const valid: ToolContext = { chatJid: TARGET, chatIncarnation: INCARNATION, reference: h.enqueued[0].reference };
  for (const context of [null, { ...valid, reference: undefined }, { ...valid, reference: { addonId: "other", intentId: valid.reference!.intentId } }, { ...valid, reference: { addonId: "telegram", intentId: "other" } }, { ...valid, chatJid: "web:other" }, { ...valid, chatIncarnation: "recreated" }]) {
    h.setContext(context);
    await foreign.emit("before_agent_start", { prompt: prompt("identical body") });
    await foreign.emit("agent_end", { messages: [assistant("foreign reply")] });
    await foreign.emit("agent_settled");
  }
  expect(h.api.sent).toEqual([]);
  expect(h.service.claimRun("web:other", valid)).toBeNull();
  const runId = h.service.claimRun(TARGET, valid);
  expect(runId).not.toBeNull();
  expect(h.service.claimRun(TARGET, valid)).toBeNull();
  await h.service.completeRun(runId!, "owned reply", false);
  expect(h.api.sent).toEqual([[OPERATOR, "owned reply"]]);
});

test("recovery prompt text without host reference fails closed and times out visibly", async () => {
  const h = harness();
  active = h.service;
  const session = fakePi();
  h.api.batches.push([textUpdate(1, "task")]);
  await h.service.start();
  await settle(() => h.enqueued.length === 1, "admission");
  h.authorize();
  await session.emit("before_agent_start", { prompt: prompt("task") });
  await session.emit("agent_end", { messages: [assistant("", "error")] });
  await session.emit("agent_settled");
  h.setContext(null);
  await session.emit("before_agent_start", { prompt: CONTINUATION });
  await session.emit("agent_end", { messages: [assistant("unprovenanced recovery")] });
  await session.emit("agent_settled");
  expect(h.timers).toHaveLength(1);
  expect(h.api.sent).toEqual([]);
  h.timers.shift()!();
  await settle(() => h.api.sent.length === 1, "failure notice");
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.runFailed]]);
});

for (const stage of ["resolveTarget", "enqueue"] as const) {
  for (const action of ["stop", "reload", "allowlist removal", "target change"] as const) {
    test(`deferred ${stage} + ${action} preserves or closes the admission obligation`, async () => {
      const h = harness();
      active = h.service;
      const gate = deferred<void>();
      let signal: AbortSignal | undefined;
      let admissions = 0;
      if (stage === "resolveTarget") h.ingress.resolveTarget = async (target, incoming) => { signal = incoming; await gate.promise; return target; };
      h.ingress.enqueue = async (request, incoming) => {
        if (stage === "enqueue") { signal = incoming; await gate.promise; }
        incoming.throwIfAborted();
        admissions++;
        h.enqueued.push(request);
        return { status: "accepted", ...request.target };
      };
      h.api.batches.push([textUpdate(1, "task")]);
      await h.service.start();
      await settle(() => Boolean(signal), `deferred ${stage}`);
      const context: SettingsContext = { ...settingsContext, resolveTarget: async (target) => target };
      let lifecycle: Promise<unknown> | void;
      if (action === "stop") lifecycle = h.service.stop();
      else if (action === "reload") lifecycle = expect(h.service.reload()).rejects.toThrow("open reply obligation");
      else lifecycle = expect(h.service.saveSettings(action === "allowlist removal" ? { allowedUserIds: [] } : { targetChatJid: "web:other", targetIncarnation: "other" }, context)).rejects.toThrow("open reply obligation");
      if (action !== "stop") await lifecycle;
      expect(signal!.aborted).toBe(action === "stop");
      gate.resolve();
      await lifecycle;
      if (action === "stop") {
        expect(admissions).toBe(0);
        expect(h.api.sent).toEqual([[OPERATOR, NOTICES.terminal]]);
      } else {
        await settle(() => admissions === 1 && h.api.polls === 2, "live admission and next poll");
        expect(h.service.connected).toBeTrue();
        const runId = h.service.claimRun(TARGET, { chatJid: TARGET, chatIncarnation: INCARNATION, reference: h.enqueued[0].reference });
        expect(runId).not.toBeNull();
        await h.service.completeRun(runId!, "reply", false);
        expect(h.api.sent).toEqual([[OPERATOR, "reply"]]);
      }
      expect(h.service["pending"]).toBeNull();
      await h.service.saveSettings({ pollingTimeout: 45 }, settingsContext);
      expect(h.service.readStoredSettings().pollingTimeout).toBe(45);
    });
  }
}

for (const outcome of ["resolveTarget", "rejected", "unknown", "unverified", "verified"] as const) {
  test(`non-closing fence during deferred admission: ${outcome}`, async () => {
    const h = harness();
    active = h.service;
    const gate = deferred<void>();
    let waiting = false;
    if (outcome === "resolveTarget") h.ingress.resolveTarget = async (target) => { waiting = true; await gate.promise; return target; };
    else h.ingress.enqueue = async (request) => {
      waiting = true;
      await gate.promise;
      if (outcome === "rejected" || outcome === "unknown") throw { delivery: outcome };
      return { status: "accepted", ...request.target, incarnation: outcome === "unverified" ? "other" : INCARNATION };
    };
    h.api.batches.push([textUpdate(1, "task")]);
    await h.service.start();
    await settle(() => waiting, "deferred admission");
    h.service["fenceIngress"]();
    gate.resolve();
    await settle(() => !h.service.connected, "fenced loop exit");
    expect(h.service.status).not.toBe("Connected");
    if (outcome === "verified") {
      expect(h.service["pending"]).not.toBeNull();
      expect(h.api.sent).toEqual([]);
      const runId = h.service["pending"]!.runId;
      await h.service.completeRun(runId, "accepted reply", false);
      expect(h.api.sent).toEqual([[OPERATOR, "accepted reply"]]);
    } else {
      expect(h.service["pending"]).toBeNull();
      expect(h.api.sent).toEqual([[OPERATOR, outcome === "resolveTarget" || outcome === "rejected" ? NOTICES.failed : NOTICES.unknown]]);
    }
    await h.service.saveSettings({ pollingTimeout: 45 }, settingsContext);
    expect(h.service.readStoredSettings().pollingTimeout).toBe(45);
  });
}

test("a deferred client creation and a queued start cannot launch a stale poll loop", async () => {
  const client = deferred<TelegramApi>();
  let creating = false;
  const h = harness({ createApi: async () => { creating = true; return client.promise; } });
  active = h.service;
  const starting = h.service.start();
  const queued = h.service.start();
  await settle(() => creating, "client creation");
  const stopping = h.service.stop();
  client.resolve(h.api);
  await Promise.all([starting, queued, stopping]);
  expect(h.api.polls).toBe(0);
  expect(h.service.connected).toBeFalse();
});

test("stop fences a deferred getMe before any poll loop starts", async () => {
  const h = harness();
  active = h.service;
  const me = deferred<{ id: number }>();
  let signal: AbortSignal | undefined;
  h.api.getMe = async (incoming?: AbortSignal) => { signal = incoming; return me.promise; };
  await h.service.start();
  await settle(() => Boolean(signal), "getMe");
  const stopping = h.service.stop();
  expect(signal!.aborted).toBeTrue();
  me.resolve({ id: 42 });
  await stopping;
  expect(h.api.polls).toBe(0);
});

for (const phase of ["pending", "delivering"] as const) {
  test(`no-op save with ${phase} obligation does not restart and delivers exactly once`, async () => {
    const h = harness();
    active = h.service;
    const runId = await admit(h);
    const gate = deferred<void>();
    let started = false;
    let delivery: Promise<void> | undefined;
    if (phase === "delivering") {
      h.api.sendHook = async () => { started = true; await gate.promise; };
      delivery = h.service.completeRun(runId, "reply", false);
      await settle(() => started, "reply sending");
    }
    const polls = h.api.polls;
    const ingressSignal = h.service["active"]!.ingress.signal;
    await h.service.saveSettings(h.service.readStoredSettings(), settingsContext);
    expect(ingressSignal.aborted).toBeFalse();
    expect(h.tokens).toHaveLength(1);
    expect(h.api.polls).toBe(polls);
    gate.resolve();
    await (delivery ?? h.service.completeRun(runId, "reply", false));
    await h.service.completeRun(runId, "reply again", false);
    expect(h.api.sent).toEqual([[OPERATOR, "reply"]]);
  });

  test(`material save with ${phase} obligation is rejected without fencing ingress`, async () => {
    const h = harness();
    active = h.service;
    const runId = await admit(h);
    const gate = deferred<void>();
    let started = false;
    let delivery: Promise<void> | undefined;
    if (phase === "delivering") {
      h.api.sendHook = async () => { started = true; await gate.promise; };
      delivery = h.service.completeRun(runId, "reply", false);
      await settle(() => started, "reply sending");
    }
    const old = h.service.readStoredSettings();
    const ingressSignal = h.service["active"]!.ingress.signal;
    await expect(h.service.saveSettings({ pollingTimeout: 45 }, settingsContext)).rejects.toThrow("open reply obligation");
    expect(ingressSignal.aborted).toBeFalse();
    expect(h.service.connected).toBeTrue();
    expect(h.service.readStoredSettings()).toEqual(old);
    gate.resolve();
    await (delivery ?? h.service.completeRun(runId, "reply", false));
    expect(h.api.sent).toEqual([[OPERATOR, "reply"]]);
  });
}

for (const action of ["stop", "disable"] as const) {
  for (const phase of ["pending", "deferred", "multipart", "retrying"] as const) {
    test(`${action} during ${phase} reply preserves delivery lifetime and sends a terminal notice`, async () => {
      const wait = deferred<void>();
      let retrying = false;
      let retrySignal: AbortSignal | undefined;
      const h = harness({ sleep: async (_ms, signal) => { retrying = true; retrySignal = signal; await wait.promise; } });
      active = h.service;
      const runId = await admit(h);
      let sending = false;
      if (phase === "deferred" || phase === "multipart") h.api.sendHook = async () => {
        if (!sending) { sending = true; await wait.promise; }
      };
      if (phase === "retrying") h.api.sendErrors.push({ error_code: 429, parameters: { retry_after: 2 } });
      const reply = phase === "multipart" ? "x".repeat(9000) : "reply";
      const delivery = phase === "pending" ? Promise.resolve() : h.service.completeRun(runId, reply, false);
      if (phase === "retrying") await settle(() => retrying, "retry sleep");
      if (phase === "deferred" || phase === "multipart") await settle(() => sending, "deferred send");
      const stopping = action === "stop" ? h.service.stop() : h.service.saveSettings({ enabled: false }, settingsContext);
      expect(h.service["active"]!.ingress.signal.aborted).toBeTrue();
      expect(h.service["active"]!.delivery.signal.aborted).toBeFalse();
      wait.resolve();
      await Promise.all([stopping, delivery]);
      expect(h.api.sent.at(-1)).toEqual([OPERATOR, NOTICES.terminal]);
      expect(h.api.sent.filter(([, text]) => text === NOTICES.terminal)).toHaveLength(1);
      expect(h.api.sent).toHaveLength(phase === "deferred" || phase === "multipart" ? 2 : 1);
      if (retrySignal) expect(retrySignal.aborted).toBeTrue();
      expect(h.api.sendSignals.every((signal) => signal.aborted)).toBeTrue();
      expect(h.service["pending"]).toBeNull();
      await h.service.completeRun(runId, "late reply", false);
      expect(h.api.sent.at(-1)).toEqual([OPERATOR, NOTICES.terminal]);
    });
  }
}

test("update IDs are safe, nonnegative, strictly high-water fenced before gate or notices", async () => {
  const h = harness();
  active = h.service;
  h.api.batches.push([
    ...[NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1].map((id) => textUpdate(id, "/start")),
    { ...textUpdate(0, "/start"), update_id: undefined },
    { ...textUpdate(0, "/start"), update_id: "1" },
    textUpdate(0, "/start"), textUpdate(0, "/start"),
    textUpdate(5, "ignored stranger", 999), textUpdate(4, "/start"), textUpdate(5, "/start"),
    textUpdate(6, "/start"), textUpdate(6, "/start"), textUpdate(3, "/start"),
  ]);
  await h.service.start();
  await settle(() => h.api.polls === 2, "second poll");
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.start], [OPERATOR, NOTICES.start]]);
  expect(h.enqueued).toEqual([]);
  expect(h.api.offsets).toEqual([undefined, 7]);
});

test("duplicate after completed reply cannot enqueue again", async () => {
  const h = harness();
  active = h.service;
  const runId = await admit(h);
  await h.service.completeRun(runId, "reply", false);
  h.api.push([textUpdate(1, "task"), textUpdate(0, "older")]);
  await settle(() => h.api.polls >= 3, "third poll");
  expect(h.enqueued).toHaveLength(1);
  expect(h.api.sent).toEqual([[OPERATOR, "reply"]]);
});

test("uncertain post-admission errors notify and never retry ingress", async () => {
  const h = harness();
  active = h.service;
  let attempts = 0;
  h.ingress.enqueue = async () => { attempts++; throw Object.assign(new Error("unknown"), { delivery: "unknown" }); };
  h.api.batches.push([textUpdate(1, "task"), textUpdate(1, "task")]);
  await h.service.start();
  await settle(() => h.api.polls === 2, "second poll");
  expect(attempts).toBe(1);
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.unknown]]);
});

test("reload supersedes a deferred start without polling the old client", async () => {
  const client = deferred<TelegramApi>();
  const oldApi = new FakeApi();
  let clients = 0;
  const h = harness({ createApi: async () => ++clients === 1 ? client.promise : h.api });
  active = h.service;
  const starting = h.service.start();
  await settle(() => clients === 1, "first client creation");
  const reloading = h.service.reload();
  client.resolve(oldApi);
  await Promise.all([starting, reloading]);
  await settle(() => h.api.polls === 1, "new client polling");
  expect(oldApi.polls).toBe(0);
  expect(clients).toBe(2);
});

test("a lifecycle fence during request target validation prevents a stale settings write", async () => {
  const h = harness();
  active = h.service;
  await h.service.start();
  const old = h.service.readStoredSettings();
  const gate = deferred<void>();
  let resolving = false;
  const context: SettingsContext = { ...settingsContext, resolveTarget: async (target) => { resolving = true; await gate.promise; return target; } };
  const saving = h.service.saveSettings({ pollingTimeout: 45 }, context);
  const rejected = saving.catch((error: Error) => error);
  await settle(() => resolving, "request target validation");
  await h.service.stop();
  gate.resolve();
  const error = await rejected;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("lifecycle changed");
  expect(h.service.readStoredSettings()).toEqual(old);
  expect(h.tokens).toHaveLength(1);
});

test("stop also drains an in-flight typing send before closing delivery", async () => {
  const h = harness();
  active = h.service;
  const action = deferred<boolean>();
  let signal: AbortSignal | undefined;
  h.api.sendChatAction = async (_chatId?: number, _action?: "typing", _other?: Record<string, unknown>, incoming?: AbortSignal) => { signal = incoming; return action.promise; };
  await admit(h);
  await settle(() => Boolean(signal), "typing send");
  const stopping = h.service.stop();
  expect(signal!.aborted).toBeFalse();
  action.resolve(true);
  await stopping;
  expect(signal!.aborted).toBeTrue();
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.terminal]]);
});

for (const failure of ["context", "incarnation", "target", "storage", "write"] as const) {
  test(`rejected ${failure} save leaves the running poller untouched`, async () => {
    const h = harness({ ingress: null });
    active = h.service;
    await h.service.start();
    await settle(() => h.api.polls === 1, "live poll");
    const run = h.service["active"]!;
    const old = h.service.readStoredSettings();
    const kv = h.interop.getExtensionKvStore();
    let context: SettingsContext | null = settingsContext;
    let payload: Record<string, unknown> = { pollingTimeout: 45 };
    if (failure === "context") context = null;
    if (failure === "incarnation") payload.targetIncarnation = "";
    if (failure === "target") context = { ...settingsContext, resolveTarget: async () => null };
    if (failure === "storage") h.interop.getExtensionKvStore = () => { throw new Error("unavailable"); };
    if (failure === "write") h.interop.getExtensionKvStore = () => ({ ...kv, set: () => { throw new Error("write failed"); } });
    await expect(h.service.saveSettings(payload, context)).rejects.toThrow();
    h.interop.getExtensionKvStore = () => kv;
    expect(h.service["active"]).toBe(run);
    expect(run.ingress.signal.aborted).toBeFalse();
    expect(h.service.connected).toBeTrue();
    expect(h.service.readStoredSettings()).toEqual(old);
    h.api.push([textUpdate(1, "/start")]);
    await settle(() => h.api.sent.length === 1, "poll still receiving");
    expect(h.api.sent).toEqual([[OPERATOR, NOTICES.unavailable]]);
  });
}

test("disable commits and closes an obligation even when its target was deleted", async () => {
  const h = harness();
  active = h.service;
  await admit(h);
  let resolutions = 0;
  await h.service.saveSettings({ enabled: false }, { ...settingsContext, resolveTarget: async () => { resolutions++; return null; } });
  expect(resolutions).toBe(0);
  expect(h.service.readStoredSettings().enabled).toBeFalse();
  expect(h.service["active"]).toBeNull();
  expect(h.service["pending"]).toBeNull();
  expect(h.api.sent).toEqual([[OPERATOR, NOTICES.terminal]]);
  expect(await h.service.view()).toMatchObject({ enabled: false, connected: false, status: "Stopped" });
});

test("unchanged save returns without context or target validation", async () => {
  const h = harness();
  active = h.service;
  await h.service.start();
  await settle(() => h.api.polls === 1, "live poll");
  const run = h.service["active"];
  await h.service.saveSettings({});
  expect(h.service["active"]).toBe(run);
  expect(run!.ingress.signal.aborted).toBeFalse();
});

test("keychain-only rotation on save connects the new token API without leaking secrets", async () => {
  const options: HarnessOptions = { keychain: "old:keychain-secret" };
  const h = harness(options);
  active = h.service;
  const rotated = new FakeApi();
  h.service["deps"].createApi = async (token) => {
    h.tokens.push(token);
    return token === "old:keychain-secret" ? h.api : rotated;
  };
  await h.service.start();
  await settle(() => h.api.polls === 1, "old API poll");
  options.keychain = "new:keychain-secret";
  await h.service.saveSettings({}, settingsContext);
  await settle(() => rotated.polls === 1, "new API poll");
  expect(h.tokens).toEqual(["old:keychain-secret", "new:keychain-secret"]);
  expect(rotated.getMeCalls).toBe(1);
  expect(h.api.getMeCalls).toBe(1);
  for (const token of h.tokens) {
    expect(JSON.stringify([...h.kv])).not.toContain(token);
    expect(h.logs.join("\n")).not.toContain(token);
  }
});

for (const action of ["start", "reload", "save"] as const) {
  for (const phase of ["connect", "poll"] as const) {
    test(`fatal token rejection during ${phase} remains restartable via ${action}`, async () => {
      const options: HarnessOptions = { keychain: "old:token" };
      const h = harness(options);
      active = h.service;
      const recovered = new FakeApi();
      h.service["deps"].createApi = async (token) => token === "old:token" ? h.api : recovered;
      if (phase === "connect") h.api.getMeErrors.push({ error_code: 401 });
      else h.api.getUpdates = async () => { throw { error_code: 401 }; };
      await h.service.start();
      await settle(() => h.service["active"] === null, "failed run released");
      expect(h.service.status).toBe("Error: Telegram rejected the bot token");
      expect(h.service.connected).toBeFalse();
      options.keychain = "new:token";
      if (action === "save") await h.service.saveSettings({}, settingsContext);
      else await h.service[action]();
      await settle(() => recovered.polls === 1, "recovered poll");
      expect(h.service.connected).toBeTrue();
      expect(recovered.getMeCalls).toBe(1);
    });
  }
}

test("fatal token rejection after a verified admission releases the obligation so later saves work", async () => {
  const h = harness();
  active = h.service;
  await admit(h);
  expect(h.service["pending"]).not.toBeNull();
  const waiting = h.api.wake;
  h.api.getUpdates = async () => { throw { error_code: 401 }; };
  waiting?.();
  await settle(() => h.service["active"] === null, "failed run released");
  expect(h.service["pending"]).toBeNull();
  expect(h.service.status).toBe("Error: Telegram rejected the bot token");
  await h.service.saveSettings({ pollingTimeout: 45 }, settingsContext);
  expect((h.kv.get("global:settings") as { pollingTimeout: number }).pollingTimeout).toBe(45);
});

test("exhausted reply retries send a single non-retried delivery-failure notice, never a stop notice", async () => {
  const h = harness();
  active = h.service;
  const runId = await admit(h);
  const attempts: string[] = [];
  h.api.sendHook = async (_chatId, text) => {
    attempts.push(text);
    throw { error_code: 500 };
  };
  await h.service.completeRun(runId, "reply", false);
  expect(attempts).toEqual(["reply", "reply", "reply", "reply", NOTICES.sendFailed]);
  expect(attempts).not.toContain(NOTICES.terminal);
  expect(h.service["pending"]).toBeNull();
  expect(h.service.connected).toBeTrue();
});

test("admission during settings target validation rejects the save without fencing", async () => {
  const h = harness();
  active = h.service;
  await h.service.start();
  await settle(() => h.api.polls === 1, "live poll");
  const gate = deferred<void>();
  let validating = false;
  const saving = h.service.saveSettings({ pollingTimeout: 45 }, {
    ...settingsContext,
    resolveTarget: async (target) => { validating = true; await gate.promise; return target; },
  });
  const result = saving.catch((error: Error) => error);
  await settle(() => validating, "settings target validation");
  h.api.push([textUpdate(1, "task")]);
  await settle(() => h.enqueued.length === 1 && h.api.polls === 2, "new obligation");
  const signal = h.service["active"]!.ingress.signal;
  gate.resolve();
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("open reply obligation");
  expect(signal.aborted).toBeFalse();
  expect(h.service.readStoredSettings().pollingTimeout).toBe(30);
  const runId = h.service.claimRun(TARGET, { chatJid: TARGET, chatIncarnation: INCARNATION, reference: h.enqueued[0].reference });
  await h.service.completeRun(runId!, "reply", false);
  await h.service.saveSettings({ pollingTimeout: 45 }, settingsContext);
  expect(h.service.readStoredSettings().pollingTimeout).toBe(45);
});

test("keychain-only rotation waits for an open obligation without fencing", async () => {
  const options: HarnessOptions = { keychain: "old:token" };
  const h = harness(options);
  active = h.service;
  const runId = await admit(h);
  const signal = h.service["active"]!.ingress.signal;
  options.keychain = "new:token";
  await expect(h.service.saveSettings({}, settingsContext)).rejects.toThrow("open reply obligation");
  expect(signal.aborted).toBeFalse();
  expect(h.tokens).toEqual(["old:token"]);
  await h.service.completeRun(runId, "reply", false);
  await h.service.saveSettings({}, settingsContext);
  expect(h.tokens).toEqual(["old:token", "new:token"]);
  expect(h.api.sent).toEqual([[OPERATOR, "reply"]]);
});
