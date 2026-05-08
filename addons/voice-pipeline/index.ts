/**
 * voice-pipeline — piclaw extension
 *
 * ESPHome-only voice pipeline: connects to Ava on the ThinkSmart View,
 * drives wake word → Azure STT → Flint LLM → Azure TTS → announce.
 *
 * The ESPHome client starts eagerly on extension load (not waiting for a
 * session_start) so the connection is always live, even between user turns.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { loadConfig } from "./config.ts";
import { ensureTtsChat, closeDb } from "./store/messages.ts";
import { addWavHeader, EspHomeClient } from "./esphome/client.ts";
import { VoiceQueue } from "./voice-queue.ts";

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();

  if (!cfg) {
    pi.registerCommand("voice-setup", {
      description: "Show voice pipeline setup instructions",
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          "Voice pipeline not configured — set AZURE_SPEECH_KEY",
          "warning",
        );
      },
    });
    return;
  }

  if (!cfg.esphome) {
    console.log("[voice] ESPHome not configured — set ESPHOME_HOST");
    return;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  const queue = new VoiceQueue();

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
  const client = new EspHomeClient(cfg.esphome, cfg, rpcChat);
  client.start().then(() => {
    console.log(`[voice] ESPHome → ${cfg.esphome!.host}:${cfg.esphome!.port}`);
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
    parameters: Type.Object({
      command: StringEnum(["announce", "play", "pause", "stop", "mute", "unmute", "volume", "scene", "wake", "sensors", "entities", "snapshot", "subtitle"] as const),
      text:  Type.Optional(Type.String({ description: "Text to announce or set as subtitle" })),
      url:   Type.Optional(Type.String({ description: "Media URL to play" })),
      scene: Type.Optional(Type.String({ description: "Notification scene name" })),
      level: Type.Optional(Type.Number({ description: "Volume 0.0–1.0" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      switch (params.command) {
        case "announce": {
          if (!params.text) return { content: [{ type: "text", text: "text required" }] };
          const { synthesize } = await import("./azure/tts.ts");
          const pcm = await synthesize(params.text, {
            region: cfg.azure.region, key: cfg.azure.key,
            voice: cfg.azure.ttsVoice, language: cfg.azure.ttsLang,
          });
          const pcmWav = addWavHeader(pcm, 16000, 1, 16);
          const id = `${crypto.randomUUID()}.wav`;
          const { ttsCache } = await import("./esphome/client.ts");
          ttsCache.set(id, pcmWav);
          const url = `http://${cfg.esphome!.serverHost}:${cfg.esphome!.ttsHttpPort}/${id}`;
          client.announce(url, params.text);
          return { content: [{ type: "text", text: `Announcing: "${params.text}"` }] };
        }
        case "subtitle":
          client.setTextEntity("conversation_subtitles", params.text ?? "");
          return { content: [{ type: "text", text: "Subtitle set" }] };
        case "play":    params.url ? client.mediaPlay(params.url) : client.mediaCommand("play"); return { content: [{ type: "text", text: "Playing" }] };
        case "pause":   client.mediaCommand("pause");  return { content: [{ type: "text", text: "Paused" }] };
        case "stop":    client.mediaCommand("stop");   return { content: [{ type: "text", text: "Stopped" }] };
        case "mute":    client.setMute(true);          return { content: [{ type: "text", text: "Muted" }] };
        case "unmute":  client.setMute(false);         return { content: [{ type: "text", text: "Unmuted" }] };
        case "wake":    client.wake();                 return { content: [{ type: "text", text: "Wake triggered" }] };
        case "volume":  client.setVolume(params.level ?? 0.5); return { content: [{ type: "text", text: `Volume → ${Math.round((params.level ?? 0.5) * 100)}%` }] };
        case "scene":   client.triggerScene(params.scene ?? ""); return { content: [{ type: "text", text: `Scene: ${params.scene}` }] };
        case "sensors": return { content: [{ type: "text", text: JSON.stringify(client.getSensors(), null, 2) }] };
        case "entities":return { content: [{ type: "text", text: JSON.stringify(client.listEntities(), null, 2) }] };
        case "snapshot": {
          const img = await client.requestSnapshot();
          if (!img) return { content: [{ type: "text", text: "snapshot timeout" }] };
          return { content: [
            { type: "text", text: `${img.length} byte JPEG` },
            { type: "image", source: { type: "base64", mediaType: "image/jpeg", data: Buffer.from(img).toString("base64") } },
          ]};
        }
        default: return { content: [{ type: "text", text: `unknown command: ${params.command}` }] };
      }
    },
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("voice", `🎤 Ava → ${cfg.esphome!.host} | ${client.entities.size} entities`);
  });

  pi.on("session_shutdown", async () => {
    client.stop();
    closeDb();
  });

  pi.registerCommand("voice-status", {
    description: "Voice pipeline status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `🎤 ESPHome → ${cfg.esphome?.host}:${cfg.esphome?.port} | ${client.entities.size} entities`,
        "info",
      );
    },
  });
}
