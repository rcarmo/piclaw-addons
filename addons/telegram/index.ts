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
const BOT_TOKEN_KEYCHAIN = "telegram/bot-token";

function getConfig(): { botToken: string; enabled: boolean; pollingTimeout: number } {
  const interop = (globalThis as any).__piclawRuntimeInterop;
  const kv = interop?.getExtensionKvStore?.();
  const legacyKvToken = typeof kv?.get(ADDON_ID, "botToken") === "string" ? String(kv.get(ADDON_ID, "botToken")).trim() : "";
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || process.env.PICLAW_TELEGRAM_BOT_TOKEN?.trim() || legacyKvToken;
  const enabled = process.env.PICLAW_TELEGRAM_ENABLED === "1" || kv?.get(ADDON_ID, "enabled") === true;
  const storedTimeout = Number(kv?.get(ADDON_ID, "pollingTimeout"));
  const pollingTimeout = Number(process.env.PICLAW_TELEGRAM_POLLING_TIMEOUT) || (Number.isFinite(storedTimeout) && storedTimeout > 0 ? storedTimeout : 30);
  return { botToken, enabled, pollingTimeout };
}

export function handleGetConfig() {
  const { botToken, enabled, pollingTimeout } = getConfig();
  return {
    enabled,
    pollingTimeout,
    connected: Boolean((globalThis as any).__telegramConnected),
    botTokenConfigured: Boolean(botToken),
    botTokenKeychain: BOT_TOKEN_KEYCHAIN,
  };
}

export function handleSetConfig(payload: unknown) {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const kv = (globalThis as any).__piclawRuntimeInterop?.getExtensionKvStore?.();
  if (typeof body.enabled === "boolean") kv?.set(ADDON_ID, "enabled", body.enabled);
  if (typeof body.pollingTimeout === "number" && Number.isFinite(body.pollingTimeout)) {
    kv?.set(ADDON_ID, "pollingTimeout", Math.max(5, Math.min(120, Math.round(body.pollingTimeout))));
  }
  return { ok: true, ...handleGetConfig() };
}

type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: { get?: (payload: unknown, req: Request) => unknown | Promise<unknown>; set?: (payload: unknown, req: Request) => unknown | Promise<unknown> },
  extensionPath?: string,
) => "created" | "updated";

const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
if (typeof registerAddonConfigApi === "function") {
  registerAddonConfigApi(ADDON_ID, "config", {
    get: async () => handleGetConfig(),
    set: async (payload) => handleSetConfig(payload),
  }, import.meta.dir);
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
