/**
 * voice-pipeline — piclaw extension
 *
 * ESPHome-only voice pipeline: connects to Ava on the ThinkSmart View,
 * drives wake word → Azure STT → Flint LLM → Azure TTS → announce.
 *
 * The ESPHome client starts eagerly on extension load (not waiting for a
 * session_start) so the connection is always live, even between user turns.
 *
 * Configuration is via environment variables. In the piclaw container these
 * map to keychain entries (e.g. keychain `azure/speech-key` → $AZURE_SPEECH_KEY),
 * so secrets can be kept in the keychain rather than plaintext env files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { loadConfig, type VoiceConfig } from "./config.ts";
import { ensureTtsChat, closeDb } from "./store/messages.ts";
import { addWavHeader, EspHomeClient, putTts, ttsUrl } from "./esphome/client.ts";
import { VoiceQueue } from "./voice-queue.ts";

export const AvaToolSchema = Type.Object({
  command: Type.String({
    enum: ["announce", "play", "pause", "stop", "mute", "unmute", "volume", "scene", "wake", "sensors", "entities", "snapshot", "subtitle"],
    description: "ThinkSmart command to execute.",
  }),
  text: Type.Optional(Type.String({ description: "Text to announce or set as subtitle" })),
  url: Type.Optional(Type.String({ description: "Media URL to play" })),
  scene: Type.Optional(Type.String({ description: "Notification scene name" })),
  level: Type.Optional(Type.Number({ description: "Volume 0.0–1.0" })),
});

type AvaToolParams = Static<typeof AvaToolSchema>;

function avaTextResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: null };
}

function avaContentResult(content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>) {
  return { content, details: null };
}

/** Human-readable configuration diagnostics for /voice-status and /voice-setup. */
function diagnostics(cfg: VoiceConfig | null): string {
  if (!cfg) return "Voice pipeline not configured — set AZURE_SPEECH_KEY (keychain: azure/speech-key).";
  const lines = [
    `Azure region: ${cfg.azure.region}`,
    `STT: ${cfg.azure.sttLang} (${cfg.azure.sttTimeoutMs}ms)  TTS: ${cfg.azure.ttsVoice} (${cfg.azure.ttsTimeoutMs}ms)`,
    cfg.esphome
      ? `ESPHome: ${cfg.esphome.host}:${cfg.esphome.port} | serverHost ${cfg.esphome.serverHost}:${cfg.esphome.ttsHttpPort} | password ${cfg.esphome.password ? "set" : "NONE (plaintext)"}`
      : "ESPHome: not configured — set ESPHOME_HOST",
    `debug: ${cfg.debug ? "on" : "off"}  storeTurns: ${cfg.storeTurns ? "on" : "off"}`,
  ];
  if (cfg.warnings.length) lines.push("", "Warnings:", ...cfg.warnings.map((w) => `  • ${w}`));
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();

  // /voice-setup and /voice-status are ALWAYS registered so they can report
  // diagnostics regardless of configuration state (#14).
  pi.registerCommand("voice-setup", {
    description: "Show voice pipeline setup instructions and current config diagnostics",
    handler: async (_args, ctx) => {
      const help = [
        "Voice pipeline configuration (env vars; keychain entries inject as env):",
        "  AZURE_SPEECH_KEY (keychain azure/speech-key)  — required",
        "  AZURE_SPEECH_REGION, AZURE_SPEECH_STT_LANG, AZURE_SPEECH_TTS_VOICE",
        "  ESPHOME_HOST — required for device control",
        "  ESPHOME_PASSWORD (keychain esphome/password), ESPHOME_SERVER_HOST, ESPHOME_TTS_PORT",
        "  VOICE_DEBUG=1 for verbose transcript/response logging",
        "",
        diagnostics(cfg),
      ].join("\n");
      ctx.ui.notify(help, cfg ? "info" : "warning");
    },
  });

  if (!cfg) {
    pi.registerCommand("voice-status", {
      description: "Voice pipeline status",
      handler: async (_args, ctx) => ctx.ui.notify(diagnostics(cfg), "warning"),
    });
    return;
  }

  // Surface config warnings at startup (#3/#7).
  for (const w of cfg.warnings) console.warn(`[voice] ${w}`);

  if (!cfg.esphome) {
    console.log("[voice] ESPHome not configured — set ESPHOME_HOST");
    pi.registerCommand("voice-status", {
      description: "Voice pipeline status",
      handler: async (_args, ctx) => ctx.ui.notify(diagnostics(cfg), "warning"),
    });
    return;
  }

  const esphome = cfg.esphome;

  // ── State ──────────────────────────────────────────────────────────────────
  const queue = new VoiceQueue({ timeoutMs: cfg.llmTimeoutMs });

  // rpcChat: send text to Flint via pi.sendUserMessage, wait for agent_end
  const rpcChat = (text: string): Promise<string> =>
    queue.chat(
      (msg) => pi.sendUserMessage(`[voice] ${msg}`, { deliverAs: "followUp" }),
      text,
    );

  // Collect agent_end to resolve pending voice requests
  pi.on("agent_end", async (event) => {
    queue.onAgentEnd(event.messages as Array<{ role: string; content: unknown }>);
  });

  // ── Start ESPHome client eagerly ───────────────────────────────────────────
  ensureTtsChat(cfg.dbPath, cfg.chatJid);
  const client = new EspHomeClient(esphome, cfg, rpcChat);
  client.start().then(() => {
    console.log(`[voice] ESPHome → ${esphome.host}:${esphome.port}`);
  }).catch((err: unknown) => {
    console.error("[voice] ESPHome start failed:", (err as Error).message);
  });

  // ── ava tool ────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "ava",
    label: "Ava (ThinkSmart)",
    description: "Control the ThinkSmart View: media playback, notification scenes, mic mute, volume, sensors, camera, wake, subtitles.",
    promptSnippet: "Control ThinkSmart display/speaker/mic",
    promptGuidelines: [
      "Use ava to play music, announce something, show a notification scene, mute/unmute the mic, check room sensors, or control the ThinkSmart View.",
    ],
    parameters: AvaToolSchema,
    async execute(_id, params: AvaToolParams, _signal, _onUpdate, _ctx) {
      // Top-level guard so a device/network error never crashes the tool call (#12).
      try {
        switch (params.command) {
          case "announce": {
            if (!params.text) return avaTextResult("text required");
            const { synthesize } = await import("./azure/tts.ts");
            const pcm = await synthesize(params.text, {
              region: cfg.azure.region, key: cfg.azure.key,
              voice: cfg.azure.ttsVoice, language: cfg.azure.ttsLang,
              timeoutMs: cfg.azure.ttsTimeoutMs,
            });
            const pcmWav = addWavHeader(pcm, 16000, 1, 16);
            const id = putTts(pcmWav, esphome.ttsTtlMs, esphome.ttsMaxEntries);
            const url = ttsUrl(esphome.serverHost, esphome.ttsHttpPort, id);
            const r = client.announce(url, params.text);
            return avaTextResult(r.ok ? `Announcing: "${params.text}"` : `Failed: ${r.message}`);
          }
          case "subtitle": {
            const r = client.setTextEntity("conversation_subtitles", params.text ?? "");
            return avaTextResult(r.ok ? "Subtitle set" : `Failed: ${r.message}`);
          }
          case "play": {
            const r = params.url ? client.mediaPlay(params.url) : client.mediaCommand("play");
            return avaTextResult(r.ok ? "Playing" : `Failed: ${r.message}`);
          }
          case "pause": { const r = client.mediaCommand("pause"); return avaTextResult(r.ok ? "Paused" : `Failed: ${r.message}`); }
          case "stop":  { const r = client.mediaCommand("stop");  return avaTextResult(r.ok ? "Stopped" : `Failed: ${r.message}`); }
          case "mute":  { const r = client.setMute(true);  return avaTextResult(r.ok ? "Muted" : `Failed: ${r.message}`); }
          case "unmute":{ const r = client.setMute(false); return avaTextResult(r.ok ? "Unmuted" : `Failed: ${r.message}`); }
          case "wake":  { const r = client.wake(); return avaTextResult(r.ok ? "Wake triggered" : `Failed: ${r.message}`); }
          case "volume":{ const r = client.setVolume(params.level ?? 0.5); return avaTextResult(r.ok ? r.message : `Failed: ${r.message}`); }
          case "scene": { const r = client.triggerScene(params.scene ?? ""); return avaTextResult(r.ok ? r.message : `Failed: ${r.message}`); }
          case "sensors": return avaTextResult(JSON.stringify(client.getSensors(), null, 2));
          case "entities":return avaTextResult(JSON.stringify(client.listEntities(), null, 2));
          case "snapshot": {
            const img = await client.requestSnapshot();
            if (!img) return avaTextResult("snapshot timeout");
            return avaContentResult([
              { type: "text", text: `${img.length} byte JPEG` },
              { type: "image", data: Buffer.from(img).toString("base64"), mimeType: "image/jpeg" },
            ]);
          }
          default: return avaTextResult(`unknown command: ${params.command}`);
        }
      } catch (err) {
        return avaTextResult(`ava error: ${(err as Error).message}`);
      }
    },
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("voice", `🎤 Ava → ${esphome.host} | ${client.entities.size} entities`);
  });

  pi.on("session_shutdown", async () => {
    client.stop();
    closeDb();
  });

  pi.registerCommand("voice-status", {
    description: "Voice pipeline status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `🎤 ESPHome → ${esphome.host}:${esphome.port} | ${client.entities.size} entities\n\n${diagnostics(cfg)}`,
        "info",
      );
    },
  });
}
