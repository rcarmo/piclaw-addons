/**
 * @rcarmo/piclaw-addon-telegram — Telegram Bot channel addon for PiClaw.
 *
 * Connects via Telegram Bot API long polling, receives inbound messages,
 * and sends agent responses back through Telegram.
 *
 * Configuration:
 *   - PICLAW_TELEGRAM_BOT_TOKEN: Bot token from @BotFather
 *   - PICLAW_TELEGRAM_ENABLED: Set to "1" to enable
 *   - PICLAW_TELEGRAM_POLLING_TIMEOUT: Long poll timeout in seconds (default 30)
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const ADDON_ID = "telegram";

function getConfig(): { botToken: string; enabled: boolean; pollingTimeout: number } {
  const interop = (globalThis as any).__piclawRuntimeInterop;
  const kv = interop?.getExtensionKvStore?.();
  const botToken = process.env.PICLAW_TELEGRAM_BOT_TOKEN?.trim() || (kv?.get(ADDON_ID, "botToken") as string) || "";
  const enabled = process.env.PICLAW_TELEGRAM_ENABLED === "1" || kv?.get(ADDON_ID, "enabled") === true;
  const pollingTimeout = Number(process.env.PICLAW_TELEGRAM_POLLING_TIMEOUT) || 30;
  return { botToken, enabled, pollingTimeout };
}

const register: ExtensionFactory = (pi: ExtensionAPI) => {
  const interop = (globalThis as any).__piclawRuntimeInterop;

  // Register channel detector for Telegram JIDs
  if (interop?.registerChannelDetector) {
    interop.registerChannelDetector((jid: string) => {
      if (jid.startsWith("telegram:") || jid.startsWith("tg:")) return "telegram";
      return null;
    });
  }

  // Register config API endpoint for the settings pane
  const registerApi = (globalThis as any).__piclaw_registerAddonConfigApi;
  if (typeof registerApi === "function") {
    registerApi(ADDON_ID, {
      async config(req: Request): Promise<Response> {
        if (req.method === "GET") {
          const { botToken, enabled, pollingTimeout } = getConfig();
          const connected = Boolean((globalThis as any).__telegramConnected);
          return new Response(JSON.stringify({
            botToken: botToken ? "***" + botToken.slice(-4) : "",
            enabled,
            pollingTimeout,
            connected,
          }), { headers: { "Content-Type": "application/json" } });
        }
        if (req.method === "POST") {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>;
          const kv = interop?.getExtensionKvStore?.();
          if (typeof body.botToken === "string") kv?.set(ADDON_ID, "botToken", body.botToken.trim());
          if (typeof body.enabled === "boolean") kv?.set(ADDON_ID, "enabled", body.enabled);
          if (typeof body.pollingTimeout === "number") kv?.set(ADDON_ID, "pollingTimeout", body.pollingTimeout);
          const { enabled, pollingTimeout } = getConfig();
          const connected = Boolean((globalThis as any).__telegramConnected);
          return new Response(JSON.stringify({ enabled, pollingTimeout, connected }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Method not allowed", { status: 405 });
      },
    });
  }

  const { botToken, enabled, pollingTimeout } = getConfig();
  if (!enabled || !botToken) return;

  // Lazy-load Telegram channel
  let channelPromise: Promise<any> | null = null;

  async function getChannel() {
    if (!channelPromise) {
      channelPromise = import("./telegram.js").then((mod) => {
        const channel = new mod.TelegramChannel({
          botToken,
          pollingTimeoutSeconds: pollingTimeout,
          chatJids: () => new Set<string>(),
          onMessage: (chatJid: string, content: string) => {
            if (interop?.postMessage) {
              interop.postMessage(chatJid, content, { source: "telegram" });
            }
          },
          onChatMetadata: () => {},
        });
        return channel;
      });
    }
    return channelPromise;
  }

  pi.on("session_start", async () => {
    try {
      const channel = await getChannel();
      await channel.connect();
      (globalThis as any).__telegramConnected = true;
      console.log("[telegram] Connected");
    } catch (err) {
      console.error("[telegram] Failed to connect:", err);
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      const channel = await getChannel();
      await channel.disconnect();
      (globalThis as any).__telegramConnected = false;
    } catch { /* ignore */ }
  });
};

export default register;
