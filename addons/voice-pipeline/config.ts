/** Config loaded from environment variables. Returns null if required vars are missing. */

export interface EspHomeConfig {
  host: string;
  port: number;
  password?: string;
  serverHost: string;   // our LAN IP that the Pi can reach
  ttsHttpPort: number;
}

export interface VoiceConfig {
  azure: {
    region: string;
    key: string;
    sttLang: string;
    ttsVoice: string;
    ttsLang: string;
  };
  dbPath: string;
  chatJid: string;
  esphome: EspHomeConfig | null;
}

export function loadConfig(): VoiceConfig | null {
  const key = process.env.AZURE_SPEECH_KEY;
  if (!key) return null;

  return {
    azure: {
      region:   process.env.AZURE_SPEECH_REGION   ?? "westeurope",
      key,
      sttLang:  process.env.AZURE_SPEECH_STT_LANG  ?? "pt-PT",
      ttsVoice: process.env.AZURE_SPEECH_TTS_VOICE ?? "pt-PT-RaquelNeural",
      ttsLang:  process.env.AZURE_SPEECH_TTS_LANG  ?? "pt-PT",
    },
    dbPath:      process.env.PICLAW_DB      ?? "/workspace/.piclaw/store/messages.db",
    chatJid:     "tts:default",
    esphome: process.env.ESPHOME_HOST
      ? {
          host:        process.env.ESPHOME_HOST,
          port:        Number(process.env.ESPHOME_PORT        ?? 6053),
          password:    process.env.ESPHOME_PASSWORD           ?? "",
          serverHost:  process.env.ESPHOME_SERVER_HOST        ?? "192.168.1.1",
          ttsHttpPort: Number(process.env.ESPHOME_TTS_PORT    ?? 11080),
        }
      : null,
  };
}
