/**
 * @rcarmo/piclaw-addon-whatsapp — WhatsApp channel addon for PiClaw.
 *
 * Connects to WhatsApp Web via Baileys, receives inbound messages,
 * and sends agent responses back through the WhatsApp channel.
 *
 * Configuration:
 *   - PICLAW_WHATSAPP_PHONE: Phone number to connect
 *   - PICLAW_WHATSAPP_ENABLED: Set to "1" to enable
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const register: ExtensionFactory = (pi: ExtensionAPI) => {
  const phone = process.env.PICLAW_WHATSAPP_PHONE?.trim();
  const enabled = process.env.PICLAW_WHATSAPP_ENABLED === "1";

  if (!enabled || !phone) {
    return;
  }

  // Register the WhatsApp channel detector so the runtime routes
  // WhatsApp JIDs correctly
  const interop = (globalThis as any).__piclawRuntimeInterop;
  if (interop?.registerChannelDetector) {
    interop.registerChannelDetector((jid: string) => {
      if (jid.includes("@s.whatsapp.net") || jid.endsWith("@g.us")) return "whatsapp";
      return null;
    });
  }

  // Lazy-load the Baileys channel implementation
  let channelPromise: Promise<any> | null = null;

  async function getChannel() {
    if (!channelPromise) {
      channelPromise = import("./whatsapp.js").then((mod) => {
        const channel = new mod.WhatsAppChannel({
          phoneNumber: phone,
          onMessage: (chatJid: string, content: string, isFromMe: boolean) => {
            if (!isFromMe) {
              // Deliver inbound messages to the agent via the runtime message API
              interop?.postMessage?.(chatJid, content, { source: "whatsapp" });
            }
          },
          onPairingCode: (code: string) => {
            console.log(`[whatsapp] Pairing code: ${code}`);
          },
        });
        return channel;
      });
    }
    return channelPromise;
  }

  // Connect on session start
  pi.on("session_start", async () => {
    try {
      const channel = await getChannel();
      await channel.connect();
      console.log("[whatsapp] Connected");
    } catch (err) {
      console.error("[whatsapp] Failed to connect:", err);
    }
  });

  // Disconnect on session shutdown
  pi.on("session_shutdown", async () => {
    try {
      const channel = await getChannel();
      await channel.disconnect();
    } catch {
      // ignore disconnect errors
    }
  });
};

export default register;
