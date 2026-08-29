import { createHash, randomUUID } from "node:crypto";
import type { ChatTransportDirectoryEntry, ChatTransportRequest, PiclawRuntimeApi } from "../compat/runtime.js";
import type { RemotePeerFoundation } from "../foundation.js";
import { buildSignedHeaders, signCanonical, verifyCanonical } from "../protocol/canonical.js";
import { PairingRepository, type PeerRecord } from "../pairing/repository.js";
import { MessagingRepository, type InboundMessageRecord, type OutboundMessageRecord } from "./repository.js";
import { isModeAllowed, MessagingPolicyRepository, normalizeAgentAlias, parseAgentAlias, type AdvertisedAgentRecord, type DeliveryMode } from "./policy.js";
import { parseReplyTarget, ReplyTokenRepository, replyTarget } from "./reply-tokens.js";
import { assertAttachmentSet, AttachmentTransferService, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, type RemoteAttachmentDescriptor } from "./attachments.js";
import { RosterService } from "./roster.js";

const MESSAGE_PATH = "/api/addons/remote-peer/v1/message";
const MAX_CONTENT_BYTES = 32 * 1024;
const MAX_IDEMPOTENCY_CHARS = 256;
const REQUEST_TIMEOUT_MS = 10_000;

export interface DeliveryReceipt {
  message_id: string;
  status: "queued" | "failed";
  target_agent_name: string;
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
    attachments: JSON.parse(record.attachments_json || "[]"),
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
    attachments: JSON.parse(record.attachments_json || "[]"),
    local_row_id: record.local_row_id,
    receipt: parseStoredReceipt(record.receipt_json),
    received_at: record.received_at,
    updated_at: record.updated_at,
  };
}

export class MessagingService {
  readonly repository: MessagingRepository;
  readonly policy: MessagingPolicyRepository;
  readonly replyTokens: ReplyTokenRepository;
  readonly attachments: AttachmentTransferService;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: MessagingServiceOptions) {
    this.repository = new MessagingRepository(options.foundation.store.db);
    this.policy = new MessagingPolicyRepository(options.foundation.store.db);
    this.now = options.now ?? (() => new Date());
    this.replyTokens = new ReplyTokenRepository(options.foundation.store.db, options.foundation.identity, this.now);
    this.fetchFn = options.fetch ?? fetch;
    this.attachments = new AttachmentTransferService(options.foundation.store.db, options.foundation.identity, `${options.foundation.dataDir}/tmp`, this.fetchFn, this.now);
  }

  listOutbound(limit = 50): Array<Record<string, unknown>> {
    return this.repository.listOutbound(limit).map(publicOutbound);
  }

  listInbound(limit = 50): Array<Record<string, unknown>> {
    return this.repository.listInbound(limit).map(publicInbound);
  }

  async directory(): Promise<{ transport: string; generated_at: string; entries: ChatTransportDirectoryEntry[]; notes: string[] }> {
    const config = this.options.foundation.loadConfig();
    const entries: ChatTransportDirectoryEntry[] = [];
    if (config.enabled) {
      for (const peer of new PairingRepository(this.options.foundation.store.db).listPeers("paired")) {
        const modes = peer.mode_ceiling === "queue-auto-steer" ? ["queue", "auto", "steer"] as const
          : peer.mode_ceiling === "queue-auto" ? ["queue", "auto"] as const
            : ["queue"] as const;
        const baseStatus = peer.blocked_reason ? "unreachable" : peer.last_seen_at ? "ready" : "stale";
        const rosterState = await new RosterService({ foundation: this.options.foundation, messaging: this.options.messaging, fetch: this.fetchFn, now: this.now }).getPeerRoster(peer);
        const attachments = rosterState.roster?.attachments || { enabled: false, max_files: 0, max_file_bytes: 0, max_total_bytes: 0 };
        entries.push({ address: `${peer.peer_alias}!inbox`, label: `${peer.display_name || peer.peer_alias} inbox`, peer_alias: peer.peer_alias, peer_fingerprint: peer.fingerprint, target_kind: "inbox", modes: [...modes], status: baseStatus, last_seen_at: peer.last_seen_at, attachments });
        // Receiver-owned policy decides whether roster access is permitted. The
        // sender must not gate discovery on its unrelated local policy record.
        const cached = rosterState;
        for (const agent of cached.roster?.agents || []) {
          const allowed = agent.allowed_modes.filter((mode): mode is DeliveryMode => modes.includes(mode as any));
          if (allowed.length) entries.push({ address: `${peer.peer_alias}!@${agent.name}`, label: `${peer.display_name || peer.peer_alias} @${agent.name}`, peer_alias: peer.peer_alias, peer_fingerprint: peer.fingerprint, target_kind: "agent", modes: allowed, status: cached.error ? "unreachable" : cached.stale ? "stale" : baseStatus, last_seen_at: cached.fetched_at || peer.last_seen_at, attachments: cached.roster.attachments });
        }
      }
    }
    return { transport: "remote-peer", generated_at: this.now().toISOString(), entries, notes: ["Use only listed addresses and modes.", "Use a stable idempotency_key when retrying uncertain delivery."] };
  }

  async validate(request: ChatTransportRequest): Promise<void> {
    const directory = await this.directory();
    let entry = directory.entries.find((candidate) => candidate.address.toLowerCase() === request.address.raw.toLowerCase());
    if (!entry && parseReplyTarget(request.address.target)) {
      // Opaque reply capabilities are intentionally absent from the public
      // directory. Validate them against the paired peer's inbox policy; the
      // receiver still verifies capability authenticity and expiry.
      entry = directory.entries.find((candidate) => candidate.peer_alias === request.address.peer && candidate.target_kind === "inbox");
    }
    if (!entry) {
      const available = directory.entries.map((candidate) => candidate.address).join(", ") || "none";
      throw new Error(`Remote address ${request.address.raw} is not available. Call chat action=directory; available addresses: ${available}.`);
    }
    if (!entry.modes.includes(request.mode)) throw new Error(`Mode ${request.mode} is not allowed for ${entry.address}. Allowed modes: ${entry.modes.join(", ")}.`);
    assertAttachmentSet(request.attachments || []);
    if (request.attachments?.length && !entry.attachments?.enabled) throw new Error(`File transfer is not enabled for ${entry.address}.`);
    if (request.attachments?.length && request.attachments.some((attachment) => attachment.size > Number(entry.attachments?.max_file_bytes || 0))) throw new Error(`An attachment exceeds ${entry.attachments?.max_file_bytes || 0} bytes allowed by ${entry.address}.`);
  }

  private validateOutbound(request: ChatTransportRequest): {
    peer: PeerRecord;
    idempotencyKey: string | null;
    contentHash: string;
    target: Record<string, string>;
  } {
    const config = this.options.foundation.loadConfig();
    if (!config.enabled) throw new Error("Remote Peer is disabled in Settings.");
    const peer = new PairingRepository(this.options.foundation.store.db).resolvePeer(request.address.peer);
    if (!peer || peer.status !== "paired" || !peer.base_url) throw new Error("Paired peer not found.");
    const mode = request.mode as DeliveryMode;
    let target: Record<string, string>;
    if (request.address.target === "inbox") target = { kind: "inbox" };
    else if (request.address.target.startsWith("@")) target = { kind: "agent", name: normalizeAgentAlias(request.address.target) };
    else {
      const token = parseReplyTarget(request.address.target);
      if (!token) throw new Error("Remote target must be inbox, @alias, or an opaque reply capability.");
      target = { kind: "reply", token };
    }
    if ((!request.content && !(request.attachments?.length)) || request.content.includes("\0") || Buffer.byteLength(request.content, "utf8") > MAX_CONTENT_BYTES) throw new Error("Message content is empty without attachments or exceeds 32 KiB.");
    if (request.attachments?.length && peer.attachments_enabled !== 1) throw new Error(`File transfer is not enabled for ${peer.peer_alias}.`);
    if (request.attachments?.some((attachment) => attachment.size > Number(peer.max_attachment_bytes || 0))) throw new Error(`An attachment exceeds ${peer.max_attachment_bytes || 0} bytes allowed by ${peer.peer_alias}.`);
    assertAttachmentSet(request.attachments || []);
    const idempotencyKey = cleanString(request.idempotency_key, MAX_IDEMPOTENCY_CHARS) || null;
    if (request.idempotency_key !== undefined && !idempotencyKey) throw new Error("Invalid idempotency key.");
    const attachmentIdentity = (request.attachments || []).map((attachment) => `${attachment.filename}\0${attachment.content_type}\0${attachment.size}\0${attachment.sha256}`).join("\n");
    return { peer, idempotencyKey, contentHash: hashContent(`${request.content}\n--attachments--\n${attachmentIdentity}`), target };
  }

  async retry(messageId: string): Promise<Record<string, unknown>> {
    const record = this.repository.getOutboundByMessageId(messageId);
    if (!record || record.status !== "failed") throw new Error("Failed outbound message not found.");
    const peer = new PairingRepository(this.options.foundation.store.db).getPeer(record.peer_instance_id);
    if (!peer || peer.status !== "paired") throw new Error("Paired peer not found.");
    const descriptors = JSON.parse(record.attachments_json || "[]") as RemoteAttachmentDescriptor[];
    const attachments = descriptors.map((descriptor) => {
      const row = this.options.foundation.store.db.query("SELECT data FROM outbound_attachments WHERE transfer_id = ? AND message_id = ?").get(descriptor.transfer_id, record.message_id) as { data: Uint8Array } | null;
      if (!row) throw new Error(`Retry data for ${descriptor.filename} is unavailable.`);
      return { filename: descriptor.filename, content_type: descriptor.content_type, size: descriptor.size, sha256: descriptor.sha256, data: new Uint8Array(row.data) };
    });
    this.repository.resetOutboundForRetry(record.message_id, this.now().toISOString());
    return await this.send({
      source_chat_jid: record.source_chat_jid,
      ...(record.source_agent_name ? { source_agent_name: record.source_agent_name } : {}),
      ...(record.source_agent_display_name ? { source_agent_display_name: record.source_agent_display_name } : {}),
      address: { kind: "bang", raw: record.target_address, peer: peer.peer_alias, target: record.target_address.split("!", 2)[1] || "inbox" },
      content: record.content,
      mode: record.mode as DeliveryMode,
      attachments,
      ...(record.idempotency_key ? { idempotency_key: record.idempotency_key } : {}),
    }, record);
  }

  async send(request: ChatTransportRequest, retryingRecord: OutboundMessageRecord | null = null): Promise<Record<string, unknown>> {
    const { peer, idempotencyKey, contentHash, target } = this.validateOutbound(request);
    const sourceAttachments = request.attachments || [];
    const existing = retryingRecord ?? (idempotencyKey ? this.repository.getOutboundByIdempotency(peer.instance_id, idempotencyKey) : null);
    if (existing && (existing.content_sha256 !== contentHash || existing.target_address !== request.address.raw || existing.mode !== request.mode)) {
      throw new Error("Idempotency key was already used for a different message.");
    }
    const storedReceipt = existing ? parseStoredReceipt(existing.receipt_json) : null;
    if (existing?.status === "delivered" && storedReceipt) return this.transportResult(request, peer, storedReceipt);
    if (existing?.status === "sending" && !retryingRecord) throw new Error("A delivery with this idempotency key is already in progress.");

    const messageId = existing?.message_id ?? `rmsg_${randomUUID()}`;
    const timestamp = this.now().toISOString();
    if (!existing) {
      this.repository.createOutbound({
        peer_instance_id: peer.instance_id,
        message_id: messageId,
        idempotency_key: idempotencyKey,
        source_chat_jid: request.source_chat_jid,
        source_agent_name: request.source_agent_name || null,
        source_agent_display_name: request.source_agent_display_name || null,
        target_address: request.address.raw,
        mode: request.mode,
        content_sha256: contentHash,
        content: request.content,
        attachments_json: JSON.stringify(sourceAttachments.map((attachment, index) => ({
          transfer_id: `rfile_${createHash("sha256").update(`${messageId}\0${index}\0${attachment.sha256}`).digest("base64url").slice(0, 32)}`,
          filename: attachment.filename,
          content_type: attachment.content_type,
          size: attachment.size,
          sha256: attachment.sha256,
        }))),
        status: "sending",
        receipt_json: null,
        error: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }

    if (sourceAttachments.length) {
      const insert = this.options.foundation.store.db.query(`INSERT OR REPLACE INTO outbound_attachments (transfer_id, message_id, filename, content_type, size, sha256, data, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const descriptors = JSON.parse((existing ?? this.repository.getOutboundByMessageId(messageId))?.attachments_json || "[]") as RemoteAttachmentDescriptor[];
      for (let index = 0; index < sourceAttachments.length; index += 1) {
        const attachment = sourceAttachments[index];
        insert.run(descriptors[index].transfer_id, messageId, attachment.filename, attachment.content_type, attachment.size, attachment.sha256, attachment.data, timestamp);
      }
    }
    const replyToken = this.replyTokens.issue(peer.instance_id, request.source_chat_jid);
    const attachmentDescriptors = JSON.parse((existing ?? this.repository.getOutboundByMessageId(messageId))?.attachments_json || "[]") as RemoteAttachmentDescriptor[];
    try {
      for (let index = 0; index < sourceAttachments.length; index += 1) {
        attachmentDescriptors[index] = await this.attachments.upload(peer, sourceAttachments[index], messageId, attachmentDescriptors[index].transfer_id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.completeOutbound(messageId, "failed", null, message, this.now().toISOString());
      throw new Error(`Remote attachment delivery failed: ${message}`);
    }
    const body = JSON.stringify({
      protocol_version: 1,
      message_id: messageId,
      idempotency_key: idempotencyKey,
      target,
      content: request.content,
      attachments: attachmentDescriptors,
      mode: request.mode,
      source_agent_name: request.source_agent_name || null,
      source_agent_display_name: request.source_agent_display_name || null,
      reply_token: replyToken,
      in_reply_to: request.in_reply_to ?? null,
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
    if (!response.ok && typeof payload.receipt_signature !== "string") {
      const message = String(payload.error || `HTTP ${response.status}`);
      this.repository.completeOutbound(messageId, "failed", null, message, this.now().toISOString());
      throw new Error(`Remote message delivery failed: ${message}`);
    }
    let receipt: DeliveryReceipt;
    try {
      receipt = this.validateReceipt(payload, peer, messageId, target.kind === "agent" ? String(target.name) : target.kind === "inbox" ? "inbox" : "reply");
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
      this.repository.deleteOutboundAttachmentData(messageId);
      this.repository.addReceipt(peer.instance_id, messageId, receipt.status, receiptJson, this.now().toISOString());
    }).immediate();
    return this.transportResult(request, peer, receipt);
  }

  private validateReceipt(payload: Record<string, unknown>, peer: PeerRecord, messageId: string, expectedTarget: string): DeliveryReceipt {
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
      || unsigned.target_agent_name !== expectedTarget || !unsigned.received_at || !signature
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
    const sourceAgentDisplayName = cleanString(body.source_agent_display_name, 256) || undefined;
    const replyToken = cleanString(body.reply_token, 1024) || undefined;
    const replyAddress = replyToken && parseReplyTarget(replyTarget(replyToken))
      ? `${peer.peer_alias}!${replyTarget(replyToken)}`
      : undefined;
    const inReplyTo = cleanString(body.in_reply_to, 256) || undefined;
    const target = body.target && typeof body.target === "object" ? body.target as Record<string, unknown> : {};
    const mode = body.mode as DeliveryMode;
    const attachmentDescriptors = Array.isArray(body.attachments) ? body.attachments as RemoteAttachmentDescriptor[] : [];
    if (attachmentDescriptors.length > 0 && peer.attachments_enabled !== 1) return responseJson({ error: "File transfer is not enabled for this peer." }, 403);
    if (attachmentDescriptors.some((attachment) => Number(attachment.size) > Number(peer.max_attachment_bytes || 0))) return responseJson({ error: "Attachment exceeds this peer's file limit." }, 403);
    if (Number(body.protocol_version) !== 1 || !/^rmsg_[A-Za-z0-9_-]{16,128}$/.test(messageId)
      || !["inbox", "agent", "reply"].includes(String(target.kind)) || !["queue", "auto", "steer"].includes(mode)
      || (!content && attachmentDescriptors.length === 0) || content.includes("\0") || Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
      return responseJson({ error: "Missing or invalid message fields." }, 400);
    }
    if (peer.messaging_scope === "none") return responseJson({ error: "Messaging is disabled for this peer." }, 403);
    let targetAgentName: string | undefined;
    let targetChatJid: string | undefined;
    let receiptTarget = "inbox";
    let advertised: AdvertisedAgentRecord | null = null;
    if (target.kind === "inbox") {
      if (peer.messaging_scope !== "inbox-only" && peer.messaging_scope !== "named-agents" && peer.messaging_scope !== "all-advertised") return responseJson({ error: "Inbox access is not allowed." }, 403);
      targetAgentName = "default";
    } else if (target.kind === "agent") {
      const alias = parseAgentAlias(String(target.name || ""));
      if (!alias) return responseJson({ error: "Invalid agent alias." }, 400);
      advertised = this.policy.getAdvertisedAgent(alias);
      if (!advertised || !this.policy.peerAllowsAgent(peer, alias)) return responseJson({ error: "Agent is not advertised to this peer." }, 403);
      targetAgentName = advertised.local_agent_name;
      receiptTarget = alias;
    } else {
      const token = typeof target.token === "string" ? target.token : "";
      const resolved = this.replyTokens.resolve(peer.instance_id, token);
      if (!resolved) return responseJson({ error: "Reply capability is invalid or expired." }, 403);
      targetChatJid = resolved.target_chat_jid;
      receiptTarget = "reply";
    }
    if (!isModeAllowed(peer, advertised, mode)) return responseJson({ error: `Delivery mode ${mode} is not allowed.` }, 403);

    const attachmentIdentity = attachmentDescriptors.map((attachment) => `${attachment.filename}\0${attachment.content_type}\0${attachment.size}\0${attachment.sha256}`).join("\n");
    const contentHash = hashContent(`${content}\n--attachments--\n${attachmentIdentity}`);
    const duplicate = this.repository.getInbound(peer.instance_id, messageId)
      ?? (idempotencyKey ? this.repository.getInboundByIdempotency(peer.instance_id, idempotencyKey) : null);
    if (duplicate) {
      if (duplicate.content_sha256 !== contentHash || duplicate.target_agent_name !== receiptTarget || duplicate.mode !== mode) {
        return responseJson({ error: "Message identity was already used for different content." }, 409);
      }
      const receipt = parseStoredReceipt(duplicate.receipt_json);
      if (receipt) {
        this.attachments.complete(messageId);
        return responseJson(receipt);
      }
      return responseJson({ error: "Message delivery is already in progress." }, 409);
    }

    const receivedAt = this.now().toISOString();
    this.repository.createInbound({
      peer_instance_id: peer.instance_id,
      message_id: messageId,
      idempotency_key: idempotencyKey,
      target_agent_name: receiptTarget,
      mode,
      content_sha256: contentHash,
      attachments_json: JSON.stringify(attachmentDescriptors),
      status: "delivering",
      local_row_id: null,
      receipt_json: null,
      received_at: receivedAt,
      updated_at: receivedAt,
    });

    let result;
    try {
      const attachments = this.attachments.claim(peer.instance_id, messageId, attachmentDescriptors);
      result = await this.options.messaging.deliverPeerMessage({
        ...(targetAgentName ? { target_agent_name: targetAgentName } : { target_chat_jid: targetChatJid }),
        content,
        ...(attachments.length ? { attachments } : {}),
        mode,
        source: {
          peer_instance_id: peer.instance_id,
          peer_fingerprint: peer.fingerprint,
          peer_alias: peer.peer_alias,
          ...(sourceAgentName ? { agent_name: sourceAgentName } : {}),
          ...(sourceAgentDisplayName ? { agent_display_name: sourceAgentDisplayName } : {}),
          ...(replyAddress ? { reply_address: replyAddress } : {}),
          message_id: messageId,
          ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const receipt = this.signReceipt({
        message_id: messageId,
        status: "failed",
        target_agent_name: receiptTarget,
        row_id: null,
        received_at: receivedAt,
        error: message,
      });
      const receiptJson = JSON.stringify(receipt);
      this.options.foundation.store.db.transaction(() => {
        this.repository.completeInbound(peer.instance_id, messageId, "failed", null, receiptJson, this.now().toISOString());
        this.attachments.complete(messageId);
        this.repository.addReceipt(peer.instance_id, messageId, receipt.status, receiptJson, receivedAt);
      }).immediate();
      return responseJson(receipt);
    }

    const receipt = this.signReceipt({
      message_id: messageId,
      status: "queued",
      target_agent_name: receiptTarget,
      row_id: result.row_id ?? null,
      received_at: receivedAt,
    });
    const receiptJson = JSON.stringify(receipt);
    this.options.foundation.store.db.transaction(() => {
      this.repository.completeInbound(peer.instance_id, messageId, "queued", result.row_id ?? null, receiptJson, this.now().toISOString());
      this.attachments.complete(messageId);
      this.repository.addReceipt(peer.instance_id, messageId, receipt.status, receiptJson, receivedAt);
    }).immediate();
    return responseJson(receipt);
  }

  private signReceipt(receipt: Omit<DeliveryReceipt, "receipt_signature">): DeliveryReceipt {
    return { ...receipt, receipt_signature: signCanonical(this.options.foundation.identity, receiptProof(receipt)) };
  }
}
