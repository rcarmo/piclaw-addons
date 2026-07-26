/**
 * @rcarmo/piclaw-addon-whatsapp — WhatsApp channel addon for PiClaw.
 *
 * Connects to WhatsApp Web via Baileys, receives inbound messages,
 * and sends agent responses back through the WhatsApp channel.
 *
 * Configuration stored via extension KV; env vars override.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const ADDON_ID = "whatsapp";

function getConfig(): { phone: string; enabled: boolean } {
  const interop = (globalThis as any).__piclawRuntimeInterop;
  const kv = interop?.getExtensionKvStore?.();
  const phone = process.env.PICLAW_WHATSAPP_PHONE?.trim() || (kv?.get(ADDON_ID, "phone") as string) || "";
  const enabled = process.env.PICLAW_WHATSAPP_ENABLED === "1" || kv?.get(ADDON_ID, "enabled") === true;
  return { phone, enabled };
}

export function handleGetConfig() {
  const { phone, enabled } = getConfig();
  return {
    phone,
    enabled,
    connected: Boolean((globalThis as any).__whatsappConnected),
    pairingCode: (globalThis as any).__whatsappPairingCode || null,
  };
}

export function handleSetConfig(payload: unknown) {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const kv = (globalThis as any).__piclawRuntimeInterop?.getExtensionKvStore?.();
  if (typeof body.phone === "string") kv?.set(ADDON_ID, "phone", body.phone.trim());
  if (typeof body.enabled === "boolean") kv?.set(ADDON_ID, "enabled", body.enabled);
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

  // Register channel detector for WhatsApp JIDs
  if (interop?.registerChannelDetector) {
    interop.registerChannelDetector((jid: string) => {
      if (jid.includes("@s.whatsapp.net") || jid.endsWith("@g.us")) return "whatsapp";
      return null;
    });
  }

  const { phone, enabled } = getConfig();
  if (!enabled || !phone) return;

  // Lazy-load Baileys channel
  let channelPromise: Promise<any> | null = null;

  async function getChannel() {
    if (!channelPromise) {
      channelPromise = import("./whatsapp.js").then((mod) => {
        const channel = new mod.WhatsAppChannel({
          phoneNumber: phone,
          onMessage: (chatJid: string, content: string, isFromMe: boolean) => {
            if (!isFromMe && interop?.postMessage) {
              interop.postMessage(chatJid, content, { source: "whatsapp" });
            }
          },
          onPairingCode: (code: string) => {
            (globalThis as any).__whatsappPairingCode = code;
            console.log(`[whatsapp] Pairing code: ${code}`);
          },
          onConnected: () => {
            (globalThis as any).__whatsappConnected = true;
            (globalThis as any).__whatsappPairingCode = null;
          },
          onDisconnected: () => {
            (globalThis as any).__whatsappConnected = false;
          },
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
    } catch (err) {
      console.error("[whatsapp] Failed to connect:", err);
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      const channel = await getChannel();
      await channel.disconnect();
    } catch { /* ignore */ }
  });
};

export default register;
