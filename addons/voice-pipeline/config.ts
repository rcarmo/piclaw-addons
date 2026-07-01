/**
 * Config for the voice pipeline, loaded from environment variables.
 *
 * Secrets (Azure Speech key, ESPHome password) are read from env, which in the
 * piclaw container is the keychain-injection path: a keychain entry named
 * `azure/speech-key` is injected as `$AZURE_SPEECH_KEY`, etc. Prefer storing
 * them in the keychain rather than plaintext env files.
 *
 * Returns null if the required Azure Speech key is missing.
 */
import { networkInterfaces } from "node:os";

export interface EspHomeConfig {
  host: string;
  port: number;
  password?: string;
  serverHost: string; // our LAN IP that the device can reach for TTS URLs
  ttsHttpPort: number;
  ttsTtlMs: number; // evict cached TTS audio after this long if unfetched
  ttsMaxEntries: number; // hard cap on cached TTS clips
}

export interface VoiceConfig {
  azure: {
    region: string;
    key: string;
    sttLang: string;
    ttsVoice: string;
    ttsLang: string;
    sttTimeoutMs: number;
    ttsTimeoutMs: number;
  };
  dbPath: string;
  chatJid: string;
  storeTurns: boolean; // persist voice turns to the message DB
  debug: boolean; // verbose transcript/response/URL logging
  llmTimeoutMs: number;
  turnTimeoutMs: number;
  esphome: EspHomeConfig | null;
  warnings: string[]; // non-fatal config diagnostics surfaced to the user
}

/** First non-internal IPv4 address, used as a sane serverHost default. */
export function detectLanIp(): string | null {
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

function num(envVal: string | undefined, fallback: number): number {
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): VoiceConfig | null {
  const key = process.env.AZURE_SPEECH_KEY;
  if (!key) return null;

  const warnings: string[] = [];
  let esphome: EspHomeConfig | null = null;

  if (process.env.ESPHOME_HOST) {
    const password = process.env.ESPHOME_PASSWORD ?? "";
    const detected = detectLanIp();
    const serverHost = process.env.ESPHOME_SERVER_HOST ?? detected ?? "127.0.0.1";

    if (!process.env.ESPHOME_SERVER_HOST) {
      warnings.push(
        detected
          ? `ESPHOME_SERVER_HOST not set — auto-detected LAN IP ${detected} for TTS callbacks. Set it explicitly if the device can't reach that address.`
          : `ESPHOME_SERVER_HOST not set and no LAN IP detected — TTS playback URLs will use 127.0.0.1 and likely fail. Set ESPHOME_SERVER_HOST.`,
      );
    }
    if (!password) {
      warnings.push(
        "ESPHOME_PASSWORD not set — using the plaintext ESPHome API with no auth. This add-on does not support the encrypted (Noise) API; set a password and keep the device on a trusted LAN.",
      );
    }

    esphome = {
      host: process.env.ESPHOME_HOST,
      port: num(process.env.ESPHOME_PORT, 6053),
      password,
      serverHost,
      ttsHttpPort: num(process.env.ESPHOME_TTS_PORT, 11080),
      ttsTtlMs: num(process.env.ESPHOME_TTS_TTL_MS, 60_000),
      ttsMaxEntries: num(process.env.ESPHOME_TTS_MAX_ENTRIES, 32),
    };
  }

  return {
    azure: {
      region: process.env.AZURE_SPEECH_REGION ?? "westeurope",
      key,
      sttLang: process.env.AZURE_SPEECH_STT_LANG ?? "pt-PT",
      ttsVoice: process.env.AZURE_SPEECH_TTS_VOICE ?? "pt-PT-RaquelNeural",
      ttsLang: process.env.AZURE_SPEECH_TTS_LANG ?? "pt-PT",
      sttTimeoutMs: num(process.env.AZURE_SPEECH_STT_TIMEOUT_MS, 15_000),
      ttsTimeoutMs: num(process.env.AZURE_SPEECH_TTS_TIMEOUT_MS, 15_000),
    },
    dbPath: process.env.PICLAW_DB ?? "/workspace/.piclaw/store/messages.db",
    chatJid: "tts:default",
    storeTurns: process.env.VOICE_STORE_TURNS !== "0",
    debug: process.env.VOICE_DEBUG === "1",
    llmTimeoutMs: num(process.env.VOICE_LLM_TIMEOUT_MS, 120_000),
    turnTimeoutMs: num(process.env.VOICE_TURN_TIMEOUT_MS, 180_000),
    esphome,
    warnings,
  };
}
