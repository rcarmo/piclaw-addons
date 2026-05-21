/**
 * channels/whatsapp.ts – WhatsApp channel adapter using Baileys.
 *
 * Connects to WhatsApp Web via the Baileys library, receives inbound
 * messages, stores them in the database, and provides sendMessage()
 * for outbound delivery.
 *
 * Features:
 *   - QR code authentication (printed to terminal on first connect).
 *   - Multi-file auth state persistence under STORE_DIR.
 *   - Automatic reconnection on disconnect.
 *   - Phone number filtering (`WHATSAPP_CONFIG.phoneNumber`) to restrict inbound handling.
 *
 * Consumers:
 *   - runtime/startup.ts lazy-loads WhatsAppChannel only when `WHATSAPP_CONFIG.enabled`
 *     and `WHATSAPP_CONFIG.phoneNumber` are configured, then wires its callbacks.
 *   - runtime/message-loop.ts polls for new WhatsApp messages via the DB.
 */

import { mkdirSync } from "fs";
import { join } from "path";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  type WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";

import { STORE_DIR, getIdentityConfig, getWhatsAppConfig } from "../core/config.js";
import type { OnChatMetadata, OnInboundMessage } from "../types.js";
import { createUuid } from "../utils/ids.js";
import { createLogger } from "../utils/logger.js";
import { sendWhatsAppTypingUpdate } from "./whatsapp-presence.js";

const log = createLogger("whatsapp");

interface BaileysLogger {
  level: string;
  child: (_obj: Record<string, unknown>) => BaileysLogger;
  trace: (_obj: unknown, _msg?: string) => void;
  debug: (_obj: unknown, _msg?: string) => void;
  info: (_obj: unknown, _msg?: string) => void;
  warn: (_obj: unknown, _msg?: string) => void;
  error: (_obj: unknown, _msg?: string) => void;
  fatal: (_obj: unknown, _msg?: string) => void;
}

// Minimal Baileys-compatible logger. We keep the library itself quiet and emit
// our own structured lifecycle logs at higher-value boundaries.
const silentLogger: BaileysLogger = {
  level: "silent",
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

function readStatusCode(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const output = (value as { output?: unknown }).output;
  if (!output || typeof output !== "object") return undefined;
  const statusCode = (output as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

/** Configuration for the WhatsApp channel: phone, callbacks. */
export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  chatJids: () => Set<string>;
  phoneNumber?: string;
  onPairingCode?: (code: string) => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 2_000; // 2s, 4s, 8s, 16s, 32s

/** WhatsApp Web channel adapter using the Baileys library. */
export class WhatsAppChannel {
  private sock!: WASocket;
  private connected = false;
  private connectReject: ((error: unknown) => void) | null = null;
  private connectResolve: (() => void) | null = null;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private opts: WhatsAppChannelOpts;
  private pairingRequested = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WhatsAppChannelOpts) {
    const whatsAppConfig = getWhatsAppConfig();
    this.opts = {
      ...opts,
      phoneNumber: opts.phoneNumber || (whatsAppConfig.phoneNumber || undefined),
    };
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = () => {
        this.connectResolve = null;
        this.connectReject = null;
        resolve();
      };
      this.connectReject = (error) => {
        this.connectResolve = null;
        this.connectReject = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      this.connectInternal(this.connectResolve).catch((error) => {
        this.settlePendingConnectError(error);
      });
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = join(STORE_DIR, "auth");
    mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    this.sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
      logger: silentLogger,
      browser: Browsers.macOS("Chrome"),
    });

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === "open" && this.opts.phoneNumber && !state.creds.registered) {
        this.requestPairingCode().catch((err) =>
          log.error("Failed to request pairing code", {
            operation: "connection.update.request_pairing_code",
            err,
          })
        );
      }

      if (qr && !this.opts.phoneNumber) {
        qrcode.generate(qr, { small: true }, (code: string) => {
          process.stdout.write("\n" + code + "\n");
          log.info("Scan the QR code above to authenticate", {
            operation: "connection.update.qr",
          });
        });
      }

      if (connection === "close") {
        this.connected = false;
        this.pairingRequested = false;
        const reason = readStatusCode(lastDisconnect?.error);
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          this.reconnectAttempts++;
          if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            log.error("Reconnect attempts exhausted", {
              operation: "connection.update.close",
              reason,
              reconnectAttempts: this.reconnectAttempts,
              maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
            });
            if (onFirstOpen) { onFirstOpen(); onFirstOpen = undefined; }
            return;
          }
          const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);
          log.warn("Disconnected; scheduling reconnect", {
            operation: "connection.update.close",
            reason,
            delayMs: delay,
            reconnectAttempts: this.reconnectAttempts,
            maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
          });
          const pending = onFirstOpen; onFirstOpen = undefined;
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectInternal(pending).catch((err) => {
              log.error("Reconnect attempt failed", {
                operation: "connection.update.reconnect",
                err,
              });
              if (pending) {
                this.settlePendingConnectError(err);
              }
            });
          }, delay);
        } else {
          log.info("Logged out; re-authentication required", {
            operation: "connection.update.logged_out",
          });
          process.exit(0);
        }
      } else if (connection === "open") {
        this.connected = true;
        this.reconnectAttempts = 0;
        log.info("Connected", { operation: "connection.update.open" });
        this.sock.sendPresenceUpdate("available").catch((err) => {
          log.warn("Failed to publish availability presence", {
            operation: "connection.update.publish_presence",
            err,
          });
        });
        this.flushOutgoingQueue().catch((err) => {
          log.error("Failed to flush queued outbound messages", {
            operation: "connection.update.flush_queue",
            err,
          });
        });
        if (onFirstOpen) { onFirstOpen(); onFirstOpen = undefined; }
      }
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const chatJid = msg.key.remoteJid;
        if (!chatJid || chatJid === "status@broadcast") continue;

        const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
        const content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "";
        const sender = msg.key.participant || msg.key.remoteJid || "";
        const senderName = msg.pushName || sender.split("@")[0];
        const fromMe = msg.key.fromMe || false;
        const assistantName = getIdentityConfig().assistantName;
        const isBotMessage = content.startsWith(`${assistantName}:`);
        const msgId = msg.key.id || createUuid("fallback");

        this.opts.onChatMetadata(chatJid, timestamp);

        // Skip non-text messages (images without captions, stickers, audio, etc.)
        if (!content) continue;

        // Store messages from monitored chats (or any from-me message for auto-registration)
        const jids = this.opts.chatJids();
        if (jids.has(chatJid) || fromMe) {
          this.opts.onMessage(chatJid, {
            id: msgId,
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
          });
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const prefixed = `${getIdentityConfig().assistantName}: ${text}`;
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
    } catch (error) {
      log.warn("Send failed; re-queued outbound message", {
        operation: "send_message",
        jid,
        err: error,
      });
      this.outgoingQueue.push({ jid, text: prefixed });
    }
  }

  isConnected(): boolean { return this.connected; }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    await sendWhatsAppTypingUpdate(this.sock, jid, isTyping);
  }

  private scheduleQueueFlush(operation: string): void {
    queueMicrotask(() => {
      void this.flushOutgoingQueue().catch((err) => {
        log.error("Failed to flush queued outbound messages", {
          operation,
          err,
        });
      });
    });
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sock.sendMessage(item.jid, { text: item.text });
      }
    } finally {
      this.flushing = false;
      if (this.connected && this.outgoingQueue.length > 0) {
        this.scheduleQueueFlush("flush_outgoing_queue.retry_after_race");
      }
    }
  }

  private async requestPairingCode(): Promise<void> {
    if (!this.opts.phoneNumber || this.pairingRequested) return;
    this.pairingRequested = true;
    try {
      const code = await this.sock.requestPairingCode(this.opts.phoneNumber);
      log.info("Pairing code requested", { operation: "request_pairing_code" });
      if (code) this.opts.onPairingCode?.(code);
    } catch (err) {
      this.pairingRequested = false;
      throw err;
    }
  }

  private settlePendingConnectError(error: unknown): void {
    const reject = this.connectReject;
    this.connectResolve = null;
    this.connectReject = null;
    reject?.(error);
  }
}
