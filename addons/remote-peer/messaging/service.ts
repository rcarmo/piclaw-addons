import { createHash, randomUUID } from "node:crypto";
import type { ChatTransportRequest, PiclawRuntimeApi } from "../compat/runtime.js";
import type { RemotePeerFoundation } from "../foundation.js";
import { buildSignedHeaders, signCanonical, verifyCanonical } from "../protocol/canonical.js";
import { PairingRepository, type PeerRecord } from "../pairing/repository.js";
import { MessagingRepository, type InboundMessageRecord, type OutboundMessageRecord } from "./repository.js";

const MESSAGE_PATH = "/api/addons/remote-peer/v1/message";
const MAX_CONTENT_BYTES = 32 * 1024;
const MAX_IDEMPOTENCY_CHARS = 256;
const REQUEST_TIMEOUT_MS = 10_000;

export interface DeliveryReceipt {
  message_id: string;
  status: "queued" | "failed";
  target_agent_name: "inbox";
  row_id: number | null;
  received_at: string;
  error?: string;
  receipt_signature: string;
}

export interface MessagingServiceOptions {
  foundation: RemotePeerFoundation;
  messaging: NonNullable<PiclawRuntimeApi["messaging"]>;
  fetch?: typeof fetch;
  now?: () => Date;
}

function hashContent(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cleanString(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= max ? text : "";
}

function receiptProof(receipt: Omit<DeliveryReceipt, "receipt_signature">): string {
  return JSON.stringify(receipt);
}

function parseStoredReceipt(value: string | null): DeliveryReceipt | null {
  if (!value) return null;
  const receipt = JSON.parse(value) as DeliveryReceipt;
  return receipt && typeof receipt === "object" ? receipt : null;
}

async function readResponseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (error) {
    if (response.ok) throw new Error("Peer returned invalid JSON.", { cause: error });
  }
  return {};
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function publicOutbound(record: OutboundMessageRecord): Record<string, unknown> {
  return {
    peer_instance_id: record.peer_instance_id,
    message_id: record.message_id,
    idempotency_key: record.idempotency_key,
    target_address: record.target_address,
    mode: record.mode,
    status: record.status,
    receipt: parseStoredReceipt(record.receipt_json),
    error: record.error,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function publicInbound(record: InboundMessageRecord): Record<string, unknown> {
  return {
    peer_instance_id: record.peer_instance_id,
    message_id: record.message_id,
    idempotency_key: record.idempotency_key,
    target_agent_name: record.target_agent_name,
    mode: record.mode,
    status: record.status,
    local_row_id: record.local_row_id,
    receipt: parseStoredReceipt(record.receipt_json),
    received_at: record.received_at,
    updated_at: record.updated_at,
  };
}

export class MessagingService {
  readonly repository: MessagingRepository;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: MessagingServiceOptions) {
    this.repository = new MessagingRepository(options.foundation.store.db);
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  listOutbound(limit = 50): Array<Record<string, unknown>> {
    return this.repository.listOutbound(limit).map(publicOutbound);
  }

  listInbound(limit = 50): Array<Record<string, unknown>> {
    return this.repository.listInbound(limit).map(publicInbound);
  }

  private validateOutbound(request: ChatTransportRequest): { peer: PeerRecord; idempotencyKey: string | null; contentHash: string } {
    const config = this.options.foundation.loadConfig();
    if (!config.enabled) throw new Error("Remote Peer is disabled in Settings.");
    if (request.address.target !== "inbox") throw new Error("This release supports only peer!inbox; advertised agent aliases arrive in the next release.");
    if (request.mode !== "queue") throw new Error("Remote Peer currently permits queue mode only.");
    const peer = new PairingRepository(this.options.foundation.store.db).resolvePeer(request.address.peer);
    if (!peer || peer.status !== "paired" || !peer.base_url) throw new Error("Paired peer not found.");
    if (peer.messaging_scope === "none") throw new Error("Messaging is disabled for this peer.");
    if (!request.content || request.content.includes("\0") || Buffer.byteLength(request.content, "utf8") > MAX_CONTENT_BYTES) throw new Error("Message content is empty or exceeds 32 KiB.");
    const idempotencyKey = cleanString(request.idempotency_key, MAX_IDEMPOTENCY_CHARS) || null;
    if (request.idempotency_key !== undefined && !idempotencyKey) throw new Error("Invalid idempotency key.");
    if (request.in_reply_to) throw new Error("Remote reply correlation arrives in the next release.");
    return { peer, idempotencyKey, contentHash: hashContent(request.content) };
  }

  async send(request: ChatTransportRequest): Promise<Record<string, unknown>> {
    const { peer, idempotencyKey, contentHash } = this.validateOutbound(request);
    const existing = idempotencyKey ? this.repository.getOutboundByIdempotency(peer.instance_id, idempotencyKey) : null;
    if (existing && (existing.content_sha256 !== contentHash || existing.target_address !== request.address.raw || existing.mode !== request.mode)) {
      throw new Error("Idempotency key was already used for a different message.");
    }
    const storedReceipt = existing ? parseStoredReceipt(existing.receipt_json) : null;
    if (existing?.status === "delivered" && storedReceipt) return this.transportResult(request, peer, storedReceipt);
    if (existing?.status === "sending") throw new Error("A delivery with this idempotency key is already in progress.");

    const messageId = existing?.message_id ?? `rmsg_${randomUUID()}`;
    const timestamp = this.now().toISOString();
    if (!existing) {
      this.repository.createOutbound({
        peer_instance_id: peer.instance_id,
        message_id: messageId,
        idempotency_key: idempotencyKey,
        source_agent_name: null,
        target_address: request.address.raw,
        mode: request.mode,
        content_sha256: contentHash,
        status: "sending",
        receipt_json: null,
        error: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    const body = JSON.stringify({
      protocol_version: 1,
      message_id: messageId,
      idempotency_key: idempotencyKey,
      target: { kind: "inbox" },
      content: request.content,
      mode: "queue",
      source_agent_name: null,
      in_reply_to: null,
    });
    const bytes = new TextEncoder().encode(body);
    let response: Response;
    try {
      response = await this.fetchFn(`${peer.base_url}${MESSAGE_PATH}`, {
        method: "POST",
        headers: buildSignedHeaders(this.options.foundation.identity, MESSAGE_PATH, bytes, peer.trust_epoch, this.now().toISOString()),
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.completeOutbound(messageId, "failed", null, message, this.now().toISOString());
      throw new Error(`Remote message delivery failed: ${message}`);
    }
    const payload = await readResponseJson(response);
    let receipt: DeliveryReceipt;
    try {
      receipt = this.validateReceipt(payload, peer, messageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.completeOutbound(messageId, "failed", null, message, this.now().toISOString());
      throw error;
    }
    if (!response.ok || receipt.status !== "queued") {
      const message = receipt.error || String(payload.error || `HTTP ${response.status}`);
      const receiptJson = JSON.stringify(receipt);
      this.options.foundation.store.db.transaction(() => {
        this.repository.completeOutbound(messageId, "failed", receiptJson, message, this.now().toISOString());
        this.repository.addReceipt(peer.instance_id, messageId, receipt.status, receiptJson, this.now().toISOString());
      }).immediate();
      throw new Error(`Remote message delivery failed: ${message}`);
    }
    const receiptJson = JSON.stringify(receipt);
    this.options.foundation.store.db.transaction(() => {
      this.repository.completeOutbound(messageId, "delivered", receiptJson, null, this.now().toISOString());
      this.repository.addReceipt(peer.instance_id, messageId, receipt.status, receiptJson, this.now().toISOString());
    }).immediate();
    return this.transportResult(request, peer, receipt);
  }

  private validateReceipt(payload: Record<string, unknown>, peer: PeerRecord, messageId: string): DeliveryReceipt {
    const unsigned = {
      message_id: cleanString(payload.message_id, 128),
      status: payload.status,
      target_agent_name: payload.target_agent_name,
      row_id: typeof payload.row_id === "number" && Number.isSafeInteger(payload.row_id) ? payload.row_id : null,
      received_at: cleanString(payload.received_at, 64),
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
    } as Omit<DeliveryReceipt, "receipt_signature">;
    const signature = cleanString(payload.receipt_signature, 4096);
    if (unsigned.message_id !== messageId || (unsigned.status !== "queued" && unsigned.status !== "failed")
      || unsigned.target_agent_name !== "inbox" || !unsigned.received_at || !signature
      || !verifyCanonical(peer.public_key, receiptProof(unsigned), signature)) {
      throw new Error("Peer returned an invalid delivery receipt.");
    }
    return { ...unsigned, receipt_signature: signature };
  }

  private transportResult(request: ChatTransportRequest, peer: PeerRecord, receipt: DeliveryReceipt): Record<string, unknown> {
    return {
      source_chat_jid: request.source_chat_jid,
      relayed: receipt.status === "queued",
      peer_instance_id: peer.instance_id,
      peer_fingerprint: peer.fingerprint,
      peer_alias: peer.peer_alias,
      message_id: receipt.message_id,
      receipt,
    };
  }

  async receive(peer: PeerRecord, body: Record<string, unknown>): Promise<Response> {
    const messageId = cleanString(body.message_id, 128);
    const idempotencyKey = cleanString(body.idempotency_key, MAX_IDEMPOTENCY_CHARS) || null;
    const content = typeof body.content === "string" ? body.content : "";
    const sourceAgentName = cleanString(body.source_agent_name, 256) || undefined;
    const target = body.target && typeof body.target === "object" ? body.target as Record<string, unknown> : {};
    if (Number(body.protocol_version) !== 1 || !/^rmsg_[A-Za-z0-9_-]{16,128}$/.test(messageId)
      || target.kind !== "inbox" || body.mode !== "queue" || body.in_reply_to != null
      || !content || content.includes("\0") || Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
      return responseJson({ error: "Missing or invalid message fields." }, 400);
    }
    if (peer.messaging_scope === "none") return responseJson({ error: "Messaging is disabled for this peer." }, 403);

    const contentHash = hashContent(content);
    const duplicate = this.repository.getInbound(peer.instance_id, messageId)
      ?? (idempotencyKey ? this.repository.getInboundByIdempotency(peer.instance_id, idempotencyKey) : null);
    if (duplicate) {
      if (duplicate.content_sha256 !== contentHash || duplicate.target_agent_name !== "inbox" || duplicate.mode !== "queue") {
        return responseJson({ error: "Message identity was already used for different content." }, 409);
      }
      const receipt = parseStoredReceipt(duplicate.receipt_json);
      if (receipt) return responseJson(receipt);
      return responseJson({ error: "Message delivery is already in progress." }, 409);
    }

    const receivedAt = this.now().toISOString();
    this.repository.createInbound({
      peer_instance_id: peer.instance_id,
      message_id: messageId,
      idempotency_key: idempotencyKey,
      target_agent_name: "inbox",
      mode: "queue",
      content_sha256: contentHash,
      status: "delivering",
      local_row_id: null,
      receipt_json: null,
      received_at: receivedAt,
      updated_at: receivedAt,
    });

    let result;
    try {
      result = await this.options.messaging.deliverPeerMessage({
        target_agent_name: "inbox",
        content,
        mode: "queue",
        source: {
          peer_instance_id: peer.instance_id,
          peer_fingerprint: peer.fingerprint,
          peer_alias: peer.peer_alias,
          ...(sourceAgentName ? { agent_name: sourceAgentName } : {}),
          message_id: messageId,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const receipt = this.signReceipt({
        message_id: messageId,
        status: "failed",
        target_agent_name: "inbox",
        row_id: null,
        received_at: receivedAt,
        error: message,
      });
      const receiptJson = JSON.stringify(receipt);
      this.options.foundation.store.db.transaction(() => {
        this.repository.completeInbound(peer.instance_id, messageId, "failed", null, receiptJson, this.now().toISOString());
        this.repository.addReceipt(peer.instance_id, messageId, receipt.status, receiptJson, receivedAt);
      }).immediate();
      return responseJson(receipt);
    }

    const receipt = this.signReceipt({
      message_id: messageId,
      status: "queued",
      target_agent_name: "inbox",
      row_id: result.row_id ?? null,
      received_at: receivedAt,
    });
    const receiptJson = JSON.stringify(receipt);
    this.options.foundation.store.db.transaction(() => {
      this.repository.completeInbound(peer.instance_id, messageId, "queued", result.row_id ?? null, receiptJson, this.now().toISOString());
      this.repository.addReceipt(peer.instance_id, messageId, receipt.status, receiptJson, receivedAt);
    }).immediate();
    return responseJson(receipt);
  }

  private signReceipt(receipt: Omit<DeliveryReceipt, "receipt_signature">): DeliveryReceipt {
    return { ...receipt, receipt_signature: signCanonical(this.options.foundation.identity, receiptProof(receipt)) };
  }
}
