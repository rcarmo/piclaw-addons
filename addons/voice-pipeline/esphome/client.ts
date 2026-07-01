/**
 * ESPHome voice assistant client.
 *
 * Connects to a linux-voice-assistant device, drives wake word → Azure STT
 * → Flint LLM → Azure TTS → device announcement.
 *
 * TTS audio is served over a built-in HTTP server so the Pi can fetch it via URL.
 */

import { connect } from "bun";
import {
  concat,
  encodeString,
  encodeUint32,
  encodeBool,
  encodeEmbedded,
  encodeFixed32,
  encodeFloat,
  parseMessage,
  getString,
  getUint32,
  getBool,
  getBytes,
} from "./proto.ts";
import { FrameReader, encodeFrame, MSG, ENTITY_MSG, VA_EVENT, VA_FEATURE } from "./framing.ts";
import { transcribe as defaultTranscribe } from "../azure/stt.ts";
import { synthesize as defaultSynthesize } from "../azure/tts.ts";
import { storeUserTurn, storeAgentTurn } from "../store/messages.ts";
import { addWavHeader } from "../audio.ts";
import type { VoiceConfig } from "../config.ts";

// Re-export so index.ts keeps a single import site for the WAV helper.
export { addWavHeader };

// ── TTS audio HTTP cache ───────────────────────────────────────────────────
// Served over a tiny HTTP server the device fetches by URL. Hardened (#4):
// GET-only, per-process bearer token (?k=), TTL eviction and a hard size cap so
// unfetched clips can't leak memory or be discovered by scanning UUIDs alone.
interface TtsEntry { audio: Uint8Array; expires: number }
const ttsStore = new Map<string, TtsEntry>();

/** Per-process secret required as a `?k=` query param to fetch TTS audio. */
export const TTS_TOKEN = crypto.randomUUID().replace(/-/g, "");

/** Store a clip and return its id, evicting expired + oldest entries first. */
export function putTts(audio: Uint8Array, ttlMs = 60_000, maxEntries = 32): string {
  const now = Date.now();
  for (const [k, v] of ttsStore) if (v.expires <= now) ttsStore.delete(k);
  while (ttsStore.size >= Math.max(1, maxEntries)) {
    const oldest = ttsStore.keys().next().value;
    if (oldest === undefined) break;
    ttsStore.delete(oldest);
  }
  const id = `${crypto.randomUUID()}.wav`;
  ttsStore.set(id, { audio, expires: now + ttlMs });
  return id;
}

/** Build the tokenised playback URL for a stored clip. */
export function ttsUrl(serverHost: string, port: number, id: string): string {
  return `http://${serverHost}:${port}/${id}?k=${TTS_TOKEN}`;
}

/** Current number of cached clips (for tests/status). */
export function ttsCacheSize(): number {
  return ttsStore.size;
}

/** Result shape returned by device control methods (#11). */
export interface ControlResult {
  ok: boolean;
  message: string;
}

function startTtsHttpServer(port: number, host?: string): Bun.Server<unknown> {
  return Bun.serve({
    port,
    ...(host && host !== "127.0.0.1" ? { hostname: host } : {}),
    fetch(req) {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      const url = new URL(req.url);
      if (url.searchParams.get("k") !== TTS_TOKEN) return new Response("forbidden", { status: 403 });
      const id = url.pathname.slice(1); // strip leading /
      const entry = ttsStore.get(id);
      if (!entry || entry.expires <= Date.now()) {
        ttsStore.delete(id);
        return new Response("not found", { status: 404 });
      }
      ttsStore.delete(id); // one-shot
      return new Response(entry.audio as unknown as BodyInit, {
        headers: { "Content-Type": "audio/wav" },
      });
    },
  });
}

// ── Message builders ─────────────────────────────────────────────────────────

function helloRequest(): Uint8Array {
  return concat(
    encodeString(1, "piclaw voice-pipeline"),
    encodeUint32(2, 1),   // api_version_major
    encodeUint32(3, 10),  // api_version_minor
  );
}

function authRequest(password = ""): Uint8Array {
  return encodeString(1, password);
}

function subscribeVoiceAssistantRequest(): Uint8Array {
  // flags: VOICE_ASSISTANT | API_AUDIO | ANNOUNCE | START_CONVERSATION
  const flags = VA_FEATURE.VOICE_ASSISTANT | VA_FEATURE.API_AUDIO |
                VA_FEATURE.ANNOUNCE | VA_FEATURE.START_CONVERSATION;
  return encodeUint32(1, flags);
}

function voiceAssistantConfigRequest(): Uint8Array {
  return new Uint8Array(0); // no external wake words
}

function pingResponse(): Uint8Array {
  return new Uint8Array(0);
}

function disconnectResponse(): Uint8Array {
  return new Uint8Array(0);
}

function eventResponse(eventType: number, data: Record<string, string> = {}): Uint8Array {
  const dataParts = Object.entries(data).map(([name, value]) =>
    encodeEmbedded(2, concat(encodeString(1, name), encodeString(2, value)))
  );
  return concat(encodeUint32(1, eventType), ...dataParts);
}

function announceRequest(mediaId: string, text: string): Uint8Array {
  return concat(
    encodeString(1, mediaId),
    encodeString(2, text),
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = "operation",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise
      .then((value) => { clearTimeout(timeout); resolve(value); })
      .catch((err) => { clearTimeout(timeout); reject(err as Error); });
  });
}


// ── ESPHome client ───────────────────────────────────────────────────────────

export interface EspHomeClientConfig {
  host: string;
  port: number;
  password?: string;
  serverHost: string;   // IP/hostname that the Pi can reach us on (for TTS URLs)
  ttsHttpPort: number;  // Port for TTS HTTP server
  ttsTtlMs: number;     // evict cached TTS audio after this long if unfetched
  ttsMaxEntries: number; // hard cap on cached TTS clips
}

type PipelineState = "idle" | "listening" | "processing";

export interface EspHomeClientDeps {
  transcribe?: typeof defaultTranscribe;
  synthesize?: typeof defaultSynthesize;
}

export interface EspHomeClientOptions {
  llmTimeoutMs?: number;
  turnTimeoutMs?: number;
}

// ── Entity registry ─────────────────────────────────────────────────────────

export type EntityKind = "sensor" | "switch" | "select" | "media_player" | "camera" | "text_sensor" | "binary_sensor" | "text";

export interface AvaEntity {
  key: number;
  name: string;
  objectId: string;
  kind: EntityKind;
}

export interface AvaState {
  sensors: Record<string, number>;   // objectId → float value
  switches: Record<string, boolean>;  // objectId → state
  selects: Record<string, string>;   // objectId → selected option
  mediaPlayer: { state: number; volume: number } | null;
  textSensors: Record<string, string>;   // read-only text sensors
  texts: Record<string, string>;         // writable text entities
}

export class EspHomeClient {
  private socket: Awaited<ReturnType<typeof connect>> | null = null;
  private reader = new FrameReader();
  private state: PipelineState = "idle";
  private audioChunks: Uint8Array[] = [];
  private ttsServer: Bun.Server<unknown> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private turnWatchdog: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  // Monotonic turn id + abort controller so a watchdog/timeout cancels the
  // in-flight STT/LLM/TTS chain and late results are dropped (#2).
  private turnId = 0;
  private turnAbort: AbortController | null = null;

  private readonly llmTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly debug: boolean;

  // Entity registry
  readonly entities = new Map<number, AvaEntity>(); // key → entity
  readonly liveState: AvaState = {
    sensors: {}, switches: {}, selects: {}, mediaPlayer: null, textSensors: {}, texts: {},
  };

  constructor(
    private cfg: EspHomeClientConfig,
    private voiceCfg: VoiceConfig,
    private rpcChat: (text: string) => Promise<string>,
    private deps: EspHomeClientDeps = {},
    private opts: EspHomeClientOptions = {},
  ) {
    this.llmTimeoutMs = opts.llmTimeoutMs ?? voiceCfg.llmTimeoutMs ?? 120_000;
    // Turn watchdog must exceed the sum of phase timeouts so it only fires on a
    // genuinely stuck turn, not a normal long LLM request (#2).
    this.turnTimeoutMs = opts.turnTimeoutMs ?? voiceCfg.turnTimeoutMs ?? 180_000;
    this.debug = voiceCfg.debug ?? false;
  }

  /** Verbose, content-bearing logs are gated behind VOICE_DEBUG (#13). */
  private dbg(...args: unknown[]): void {
    if (this.debug) console.log(...args);
  }

  async start() {
    this.ttsServer = startTtsHttpServer(this.cfg.ttsHttpPort, this.cfg.serverHost);
    console.log(`[voice:esphome] TTS HTTP server on ${this.cfg.serverHost}:${this.cfg.ttsHttpPort}`);
    if (!this.cfg.password) {
      console.warn("[voice:esphome] no password set \u2014 using the plaintext ESPHome API (no Noise encryption). Keep the device on a trusted LAN.");
    }
    await this.connect();
  }

  stop() {
    this.shuttingDown = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.clearTurnWatchdog();
    this.socket?.end();
    this.socket = null;
    this.ttsServer?.stop();
    this.ttsServer = null;
  }

  private async connect() {
    if (this.shuttingDown) return;
    console.log(`[voice:esphome] connecting to ${this.cfg.host}:${this.cfg.port}`);
    try {
      this.socket = await connect({
        hostname: this.cfg.host,
        port: this.cfg.port,
        socket: {
          data: (_s, data) => this.onData(new Uint8Array(data)),
          close: () => this.onClose(),
          error: (_s, err) => console.error("[voice:esphome] socket error:", err),
          open: () => this.onOpen(),
        },
      });
    } catch (err) {
      console.error("[voice:esphome] connection failed:", (err as Error).message);
      this.scheduleReconnect();
    }
  }

  private onOpen() {
    console.log("[voice:esphome] connected — sending Hello");
    this.reader = new FrameReader();
    this.send(MSG.HELLO_REQUEST, helloRequest());
  }

  private onClose() {
    console.log("[voice:esphome] disconnected");
    this.socket = null;
    this.clearTurnWatchdog();
    if (!this.shuttingDown) this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  private send(msgType: number, data: Uint8Array) {
    this.socket?.write(encodeFrame(msgType, data));
  }

  private onData(chunk: Uint8Array) {
    this.reader.push(chunk);
    for (const frame of this.reader.drain()) {
      this.handleFrame(frame.msgType, frame.data);
    }
  }

  private startTurnWatchdog() {
    this.clearTurnWatchdog();
    const watchedTurn = this.turnId;
    this.turnWatchdog = setTimeout(() => {
      this.turnWatchdog = null;
      if (this.state === "processing" && this.turnId === watchedTurn) {
        console.error("[voice:esphome] pipeline watchdog fired, aborting turn + forcing RUN_END");
        this.turnAbort?.abort(new Error("pipeline watchdog timeout"));
        this.resetTurn();
        this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.ERROR, { message: "pipeline timeout" }));
        this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.RUN_END));
      }
    }, this.turnTimeoutMs);
  }

  private clearTurnWatchdog() {
    if (this.turnWatchdog) {
      clearTimeout(this.turnWatchdog);
      this.turnWatchdog = null;
    }
  }

  private resetTurn() {
    this.audioChunks = [];
    this.state = "idle";
    // Invalidate the current turn so any late STT/LLM/TTS result is dropped.
    this.turnId++;
    this.turnAbort = null;
    this.clearTurnWatchdog();
  }

  private handleFrame(msgType: number, data: Uint8Array) {
    switch (msgType) {
      case MSG.HELLO_RESPONSE:
        console.log("[voice:esphome] Hello OK — authenticating");
        this.send(MSG.AUTHENTICATION_REQUEST, authRequest(this.cfg.password));
        break;

      case MSG.AUTHENTICATION_RESPONSE:
        console.log("[voice:esphome] Auth OK — subscribing to voice assistant + entities");
        this.send(MSG.VOICE_ASSISTANT_CONFIGURATION_REQUEST, voiceAssistantConfigRequest());
        this.send(MSG.SUBSCRIBE_VOICE_ASSISTANT_REQUEST, subscribeVoiceAssistantRequest());
        this.send(ENTITY_MSG.LIST_ENTITIES_REQUEST, new Uint8Array(0));
        this.send(ENTITY_MSG.SUBSCRIBE_STATES_REQUEST, new Uint8Array(0));
        break;

      case ENTITY_MSG.CAMERA_IMAGE_RESPONSE: {
        const cf = parseMessage(data);
        const imageData = getBytes(cf, 2);
        if (this._pendingSnapshot) {
          this._pendingSnapshot(imageData);
          this._pendingSnapshot = null;
        }
        break;
      }

      case MSG.PING_REQUEST:
        this.send(MSG.PING_RESPONSE, pingResponse());
        break;

      // ── Entity listing ───────────────────────────────────────────
      case ENTITY_MSG.LIST_ENTITIES_SENSOR:
      case ENTITY_MSG.LIST_ENTITIES_SWITCH:
      case ENTITY_MSG.LIST_ENTITIES_SELECT:
      case ENTITY_MSG.LIST_ENTITIES_MEDIA_PLAYER:
      case ENTITY_MSG.LIST_ENTITIES_CAMERA:
      case ENTITY_MSG.LIST_ENTITIES_TEXT_SENSOR:
      case ENTITY_MSG.LIST_ENTITIES_BINARY_SENSOR:
      case ENTITY_MSG.LIST_ENTITIES_TEXT: {
        const ef = parseMessage(data);
        const entityKinds: Record<number, EntityKind> = {
          [ENTITY_MSG.LIST_ENTITIES_SENSOR]: "sensor",
          [ENTITY_MSG.LIST_ENTITIES_SWITCH]: "switch",
          [ENTITY_MSG.LIST_ENTITIES_SELECT]: "select",
          [ENTITY_MSG.LIST_ENTITIES_MEDIA_PLAYER]: "media_player",
          [ENTITY_MSG.LIST_ENTITIES_CAMERA]: "camera",
          [ENTITY_MSG.LIST_ENTITIES_TEXT_SENSOR]: "text_sensor",
          [ENTITY_MSG.LIST_ENTITIES_BINARY_SENSOR]: "binary_sensor",
          [ENTITY_MSG.LIST_ENTITIES_TEXT]: "text",
        };
        const ent: AvaEntity = {
          key: getUint32(ef, 2),
          name: getString(ef, 3),
          objectId: getString(ef, 1),
          kind: entityKinds[msgType],
        };
        this.entities.set(ent.key, ent);
        this.dbg(`[voice:esphome] entity: ${ent.kind} "${ent.name}" (${ent.objectId}) key=${ent.key}`);
        break;
      }

      case ENTITY_MSG.LIST_ENTITIES_DONE:
        console.log(`[voice:esphome] ${this.entities.size} entities listed`);
        break;

      // ── State updates ──────────────────────────────────────────
      case ENTITY_MSG.SENSOR_STATE: {
        const sf = parseMessage(data);
        const sk = getUint32(sf, 1);
        const svf = sf.find(f => f.tag === 2 && f.wire === 5);
        if (svf) {
          const b = new Uint8Array(4);
          new DataView(b.buffer).setUint32(0, svf.value as number, true);
          const fval = new DataView(b.buffer).getFloat32(0, true);
          const ent = this.entities.get(sk);
          if (ent) this.liveState.sensors[ent.objectId] = fval;
        }
        break;
      }
      case ENTITY_MSG.SWITCH_STATE: {
        const wf = parseMessage(data);
        const wk = getUint32(wf, 1), wv = getBool(wf, 2);
        const we = this.entities.get(wk);
        if (we) this.liveState.switches[we.objectId] = wv;
        break;
      }
      case ENTITY_MSG.SELECT_STATE: {
        const lf = parseMessage(data);
        const lk = getUint32(lf, 1), lv = getString(lf, 2);
        const le = this.entities.get(lk);
        if (le) this.liveState.selects[le.objectId] = lv;
        break;
      }
      case ENTITY_MSG.MEDIA_PLAYER_STATE: {
        const mf = parseMessage(data);
        const mk = getUint32(mf, 1);
        const mvf = mf.find(f => f.tag === 3 && f.wire === 5);
        const vol = mvf
          ? (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, mvf.value as number, true); return new DataView(b.buffer).getFloat32(0, true); })()
          : 0;
        this.liveState.mediaPlayer = { state: getUint32(mf, 2), volume: vol };
        break;
      }
      case ENTITY_MSG.TEXT_SENSOR_STATE: {
        const tf = parseMessage(data);
        const tk = getUint32(tf, 1), tv = getString(tf, 2);
        const te = this.entities.get(tk);
        if (te) this.liveState.textSensors[te.objectId] = tv;
        break;
      }
      case ENTITY_MSG.TEXT_STATE: {
        const tf = parseMessage(data);
        const tk = getUint32(tf, 1), tv = getString(tf, 2);
        const te = this.entities.get(tk);
        if (te) this.liveState.texts[te.objectId] = tv;
        break;
      }

      case MSG.DISCONNECT_REQUEST:
        this.send(MSG.DISCONNECT_RESPONSE, disconnectResponse());
        this.socket?.end();
        break;

      case MSG.VOICE_ASSISTANT_REQUEST: {
        const fields = parseMessage(data);
        const start = getBool(fields, 1);
        const phrase = getString(fields, 5);

        if (!start) {
          this.resetTurn();
          this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.RUN_END));
          return;
        }

        if (start && this.state === "idle") {
          this.dbg(`[voice:esphome] wake word: "${phrase}" — listening`);
          this.state = "listening";
          this.audioChunks = [];
          this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.WAKE_WORD_START));
          this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.STT_START));
          this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.STT_VAD_START));
        }
        break;
      }

      case MSG.VOICE_ASSISTANT_AUDIO: {
        const fields = parseMessage(data);
        const chunk = getBytes(fields, 1);
        const end = getBool(fields, 2);

        if (this.state === "listening") {
          if (chunk.length > 0) this.audioChunks.push(chunk);
          if (end) {
            this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.STT_VAD_END));
            this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.STT_END));
            this.state = "processing";
            this.runPipeline();
          }
        }
        break;
      }

      case MSG.VOICE_ASSISTANT_ANNOUNCE_FINISHED:
        console.log("[voice:esphome] announce finished");
        this.resetTurn();
        this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.RUN_END));
        break;
    }
  }

  private async runPipeline() {
    const myTurn = this.turnId;
    this.turnAbort = new AbortController();
    const signal = this.turnAbort.signal;
    this.startTurnWatchdog();

    const superseded = () => this.turnId !== myTurn;

    const sttCfg = {
      region: this.voiceCfg.azure.region,
      key: this.voiceCfg.azure.key,
      language: this.voiceCfg.azure.sttLang,
      timeoutMs: this.voiceCfg.azure.sttTimeoutMs,
      signal,
    };
    const ttsCfg = {
      region: this.voiceCfg.azure.region,
      key: this.voiceCfg.azure.key,
      voice: this.voiceCfg.azure.ttsVoice,
      language: this.voiceCfg.azure.ttsLang,
      timeoutMs: this.voiceCfg.azure.ttsTimeoutMs,
      signal,
    };

    const stt = this.deps.transcribe ?? defaultTranscribe;
    const tts = this.deps.synthesize ?? defaultSynthesize;

    try {
      const total = this.audioChunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Uint8Array(total);
      let off = 0;
      for (const c of this.audioChunks) { pcm.set(c, off); off += c.length; }
      this.audioChunks = [];

      // STT (the stt module frames raw PCM as WAV internally, #1)
      const transcript = await stt(pcm, sttCfg);
      if (superseded()) return;
      this.dbg(`[voice:esphome] STT: "${transcript}"`);
      if (!transcript.trim()) {
        this.resetTurn();
        this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.RUN_END));
        return;
      }

      storeUserTurn(this.voiceCfg.dbPath, this.voiceCfg.chatJid, transcript, "\uD83C\uDFA4 Voice (ESPHome)");
      this.setTextEntity("conversation_subtitles", `\uD83D\uDDE3\uFE0F ${transcript}`);

      this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.INTENT_START));

      // LLM turn via the shared queue. A concurrent request rejects with a
      // BusyError we surface to the device rather than deadlocking (#15).
      let response: string;
      try {
        response = await withTimeout(this.rpcChat(transcript), this.llmTimeoutMs, "LLM request");
      } catch (err) {
        if ((err as { busy?: boolean }).busy) {
          this.setTextEntity("conversation_subtitles", "\u23F3 Busy, try again");
          this.resetTurn();
          this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.ERROR, { message: "assistant busy" }));
          this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.RUN_END));
          return;
        }
        throw err;
      }
      if (superseded()) return;
      this.dbg(`[voice:esphome] LLM: "${response.slice(0, 200)}"`);
      console.log(`[voice:esphome] turn complete (transcript ${transcript.length} chars, response ${response.length} chars)`);

      storeAgentTurn(this.voiceCfg.dbPath, this.voiceCfg.chatJid, response, "Flint");
      this.setTextEntity("conversation_subtitles", `\uD83D\uDCAC ${response.slice(0, 200)}`);

      this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.INTENT_END));
      this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.TTS_START));

      const pcmOut = await tts(response, ttsCfg);
      if (superseded()) return;
      const wavOut = addWavHeader(pcmOut, 16000, 1, 16);
      const ttsId = putTts(wavOut, this.cfg.ttsTtlMs, this.cfg.ttsMaxEntries);
      const mediaUrl = ttsUrl(this.cfg.serverHost, this.cfg.ttsHttpPort, ttsId);
      this.dbg(`[voice:esphome] TTS URL: ${mediaUrl}`);

      this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.TTS_END, { url: mediaUrl }));
      this.send(MSG.VOICE_ASSISTANT_ANNOUNCE_REQUEST, announceRequest(mediaUrl, response));
      this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.RUN_END));
      this.resetTurn();
    } catch (err) {
      if (superseded()) return; // watchdog or newer turn already handled cleanup
      console.error("[voice:esphome] pipeline error:", (err as Error).message);
      this.resetTurn();
      this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.ERROR, {
        message: (err as Error).message,
      }));
      this.send(MSG.VOICE_ASSISTANT_EVENT_RESPONSE, eventResponse(VA_EVENT.RUN_END));
    }
  }

  // ── Public control API ───────────────────────────────────────────────

  wake(): ControlResult {
    if (this.state !== "idle") return { ok: false, message: `cannot wake while ${this.state}` };
    this.state = "listening";
    this.audioChunks = [];
    this.send(MSG.VOICE_ASSISTANT_REQUEST, concat(
      encodeBool(1, true), encodeString(5, "manual")
    ));
    return { ok: true, message: "listening" };
  }

  triggerScene(sceneName: string): ControlResult {
    const ent = [...this.entities.values()].find(e => e.kind === "select" && e.objectId.includes("scene"));
    if (!ent) return { ok: false, message: "no scene select entity found" };
    this.send(ENTITY_MSG.SELECT_COMMAND, concat(
      encodeFixed32(1, ent.key),
      encodeString(2, sceneName),
    ));
    return { ok: true, message: `scene set to ${sceneName}` };
  }

  setMute(muted: boolean): ControlResult {
    const ent = [...this.entities.values()].find(e => e.kind === "switch" && e.objectId.includes("mute"));
    if (!ent) return { ok: false, message: "no mute switch entity found" };
    this.send(ENTITY_MSG.SWITCH_COMMAND, concat(
      encodeFixed32(1, ent.key),
      encodeBool(2, muted),
    ));
    return { ok: true, message: muted ? "muted" : "unmuted" };
  }

  mediaPlay(url: string): ControlResult {
    const ent = [...this.entities.values()].find(e => e.kind === "media_player");
    if (!ent) return { ok: false, message: "no media_player entity found" };
    this.send(ENTITY_MSG.MEDIA_PLAYER_COMMAND, concat(
      encodeFixed32(1, ent.key),
      encodeBool(2, true),
      encodeString(3, url),
    ));
    return { ok: true, message: "playing media" };
  }

  mediaCommand(cmd: "play" | "pause" | "stop" | "mute" | "unmute"): ControlResult {
    const ent = [...this.entities.values()].find(e => e.kind === "media_player");
    if (!ent) return { ok: false, message: "no media_player entity found" };
    const cmdMap = { play: 0, pause: 1, stop: 2, mute: 3, unmute: 4 };
    this.send(ENTITY_MSG.MEDIA_PLAYER_COMMAND, concat(
      encodeFixed32(1, ent.key),
      encodeBool(8, true), // has_command
      encodeUint32(9, cmdMap[cmd]),
    ));
    return { ok: true, message: `media ${cmd}` };
  }

  setVolume(level: number): ControlResult {
    const ent = [...this.entities.values()].find(e => e.kind === "media_player");
    if (!ent) return { ok: false, message: "no media_player entity found" };
    const clamped = Math.max(0, Math.min(1, level));
    this.send(ENTITY_MSG.MEDIA_PLAYER_COMMAND, concat(
      encodeFixed32(1, ent.key),
      encodeBool(6, true), // has_volume
      encodeFloat(7, clamped),
    ));
    return { ok: true, message: `volume ${Math.round(clamped * 100)}%` };
  }

  requestSnapshot(): Promise<Uint8Array | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        resolve(null);
        if (this._pendingSnapshot) this._pendingSnapshot = null;
      }, 5000);
      this._pendingSnapshot = (data) => {
        clearTimeout(timer);
        resolve(data);
      };
      this.send(ENTITY_MSG.CAMERA_IMAGE_REQUEST, concat(encodeBool(1, true)));
    });
  }

  private _pendingSnapshot: ((d: Uint8Array) => void) | null = null;

  getSensors(): Record<string, number> { return { ...this.liveState.sensors }; }

  getState(): AvaState { return JSON.parse(JSON.stringify(this.liveState)); }

  announce(mediaUrl: string, text: string): ControlResult {
    this.send(MSG.VOICE_ASSISTANT_ANNOUNCE_REQUEST, announceRequest(mediaUrl, text));
    return { ok: true, message: "announced" };
  }

  setTextEntity(objectId: string, value: string): ControlResult {
    const ent = [...this.entities.values()].find(e => e.kind === "text" && e.objectId === objectId);
    if (!ent) return { ok: false, message: `text entity not found: ${objectId}` };
    this.send(ENTITY_MSG.TEXT_COMMAND, concat(
      encodeFixed32(1, ent.key),
      encodeString(2, value),
    ));
    return { ok: true, message: `set ${objectId}` };
  }

  listEntities(): Partial<Record<EntityKind, string[]>> {
    const result: Partial<Record<EntityKind, string[]>> = {};
    for (const e of this.entities.values()) {
      (result[e.kind] ??= []).push(e.name);
    }
    return result;
  }
}
