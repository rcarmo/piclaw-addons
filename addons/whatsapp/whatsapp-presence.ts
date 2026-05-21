import { createLogger, debugSuppressedError } from "../utils/logger.js";

const log = createLogger("whatsapp");

export interface WhatsAppPresenceSocketLike {
  sendPresenceUpdate(state: "composing" | "paused", jid: string): Promise<unknown>;
}

export async function sendWhatsAppTypingUpdate(
  sock: WhatsAppPresenceSocketLike,
  jid: string,
  isTyping: boolean,
): Promise<void> {
  try {
    await sock.sendPresenceUpdate(isTyping ? "composing" : "paused", jid);
  } catch (error) {
    debugSuppressedError(log, "Transient WhatsApp typing update failed; message delivery will continue.", error, {
      jid,
      isTyping,
    });
  }
}
