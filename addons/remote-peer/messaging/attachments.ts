import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "bun:sqlite";

import type { ChatTransportAttachment } from "../compat/runtime.js";
import type { RemotePeerIdentity } from "../identity.js";
import { buildSignedHeaders, signCanonical, verifyCanonical } from "../protocol/canonical.js";
import type { NonceReplayCache } from "../protocol/nonce-cache.js";
import { verifySignedRequestHash } from "../protocol/auth.js";
import type { PeerRecord } from "../pairing/repository.js";

export const ATTACHMENT_PATH = "/api/addons/remote-peer/v1/attachment";
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 32 * 1024 * 1024;
const ATTACHMENT_TIMEOUT_MS = 30_000;
const MAX_PENDING_ATTACHMENT_BYTES_PER_PEER = 64 * 1024 * 1024;
const SAFE_FILENAME_RE = /^[^\x00-\x1f\\/]{1,255}$/u;
const SAFE_CONTENT_TYPE_RE = /^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+$/;

export interface RemoteAttachmentDescriptor {
  transfer_id: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
}

export interface ReceivedRemoteAttachment extends ChatTransportAttachment {
  transfer_id: string;
}

function cleanFilename(value: unknown): string {
  const filename = typeof value === "string" ? value.trim() : "";
  if (!SAFE_FILENAME_RE.test(filename) || filename === "." || filename === "..") throw new Error("Invalid attachment filename.");
  return filename;
}

function cleanContentType(value: unknown): string {
  const contentType = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SAFE_CONTENT_TYPE_RE.test(contentType)) throw new Error("Invalid attachment content type.");
  return contentType;
}

function cleanSha256(value: unknown): string {
  const sha256 = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid attachment SHA-256.");
  return sha256;
}

function cleanTransferId(value: unknown): string {
  const transferId = typeof value === "string" ? value.trim() : "";
  if (!/^rfile_[A-Za-z0-9_-]{16,128}$/.test(transferId)) throw new Error("Invalid attachment transfer id.");
  return transferId;
}

type AttachmentReceipt = { status: "stored"; transfer_id: string; sha256: string; size: number; receipt_signature: string };

function attachmentReceiptProof(receipt: Omit<AttachmentReceipt, "receipt_signature">): string {
  return JSON.stringify(receipt);
}

function signedAttachmentReceipt(identity: RemotePeerIdentity, descriptor: RemoteAttachmentDescriptor): AttachmentReceipt {
  const unsigned = { status: "stored" as const, transfer_id: descriptor.transfer_id, sha256: descriptor.sha256, size: descriptor.size };
  return { ...unsigned, receipt_signature: signCanonical(identity, attachmentReceiptProof(unsigned)) };
}

function descriptorFromRequest(req: Request): RemoteAttachmentDescriptor {
  const params = new URL(req.url).searchParams;
  const size = Number(params.get("size"));
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment size must be 0-${MAX_ATTACHMENT_BYTES} bytes.`);
  return {
    transfer_id: cleanTransferId(params.get("transfer_id")),
    filename: cleanFilename(params.get("filename")),
    content_type: cleanContentType(params.get("content_type")),
    size,
    sha256: cleanSha256(params.get("sha256")),
  };
}

export function assertAttachmentSet(attachments: ChatTransportAttachment[]): void {
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error(`Remote Peer supports at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`);
  let total = 0;
  for (const attachment of attachments) {
    cleanFilename(attachment.filename);
    cleanContentType(attachment.content_type);
    cleanSha256(attachment.sha256);
    if (attachment.size !== attachment.data.byteLength) throw new Error(`Attachment ${attachment.filename} size does not match its data.`);
    if (attachment.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment ${attachment.filename} exceeds ${MAX_ATTACHMENT_BYTES} bytes.`);
    if (createHash("sha256").update(attachment.data).digest("hex") !== attachment.sha256) throw new Error(`Attachment ${attachment.filename} SHA-256 does not match its data.`);
    total += attachment.size;
  }
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error(`Remote Peer attachments exceed ${MAX_ATTACHMENT_TOTAL_BYTES} bytes total.`);
}

export class AttachmentTransferService {
  private readonly pending = new Map<string, { peer_instance_id: string; descriptor: RemoteAttachmentDescriptor; data: Uint8Array; received_at: string }>();

  constructor(
    private readonly db: Database,
    private readonly identity: RemotePeerIdentity,
    private readonly tempDir: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) { mkdirSync(this.tempDir, { recursive: true }); }

  async upload(peer: PeerRecord, attachment: ChatTransportAttachment, messageId: string, transferId = `rfile_${randomUUID()}`): Promise<RemoteAttachmentDescriptor> {
    assertAttachmentSet([attachment]);
    cleanTransferId(transferId);
    const params = new URLSearchParams({
      message_id: messageId,
      transfer_id: transferId,
      filename: attachment.filename,
      content_type: attachment.content_type,
      size: String(attachment.size),
      sha256: attachment.sha256,
    });
    const path = `${ATTACHMENT_PATH}?${params.toString()}`;
    const headers = buildSignedHeaders(this.identity, path, attachment.data, peer.trust_epoch, this.now().toISOString(), randomUUID(), "application/octet-stream");
    const response = await this.fetchFn(`${peer.base_url}${path}`, { method: "POST", headers, body: attachment.data, signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS) });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(payload.error || `Attachment upload failed (${response.status}).`));
    const unsigned = { status: payload.status, transfer_id: payload.transfer_id, sha256: payload.sha256, size: payload.size } as Omit<AttachmentReceipt, "receipt_signature">;
    if (unsigned.status !== "stored" || unsigned.transfer_id !== transferId || unsigned.sha256 !== attachment.sha256 || unsigned.size !== attachment.size
      || typeof payload.receipt_signature !== "string" || !verifyCanonical(peer.public_key, attachmentReceiptProof(unsigned), payload.receipt_signature)) {
      throw new Error("Peer returned an invalid signed attachment receipt.");
    }
    return { transfer_id: transferId, filename: attachment.filename, content_type: attachment.content_type, size: attachment.size, sha256: attachment.sha256 };
  }

  async receive(req: Request, peer: PeerRecord, nonceCache: NonceReplayCache): Promise<Response> {
    let descriptor: RemoteAttachmentDescriptor;
    try { descriptor = descriptorFromRequest(req); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    const messageId = new URL(req.url).searchParams.get("message_id") || "";
    if (!/^rmsg_[A-Za-z0-9_-]{16,128}$/.test(messageId)) return Response.json({ error: "Invalid attachment message id." }, { status: 400 });
    const tempPath = join(this.tempDir, `${descriptor.transfer_id}.${randomUUID()}.part`);
    const hasher = createHash("sha256");
    let size = 0;
    try {
      if (!req.body) return Response.json({ error: "Attachment body is required." }, { status: 400 });
      const sink = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
      const reader = req.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          size += value.byteLength;
          if (size > descriptor.size || size > MAX_ATTACHMENT_BYTES) throw new Error("Attachment body exceeds its declared size.");
          hasher.update(value);
          if (!sink.write(value)) await new Promise<void>((resolve, reject) => { sink.once("drain", resolve); sink.once("error", reject); });
        }
      } finally { reader.releaseLock(); }
      await new Promise<void>((resolve, reject) => { sink.end(resolve); sink.once("error", reject); });
      if (size !== descriptor.size) return Response.json({ error: "Attachment body size mismatch." }, { status: 400 });
      const bodyHash = hasher.digest("hex");
      const verified = verifySignedRequestHash(req, bodyHash, peer, nonceCache, this.now().getTime());
      if (!verified.ok) return Response.json({ error: verified.error }, { status: 401 });
      if (bodyHash !== descriptor.sha256) return Response.json({ error: "Attachment SHA-256 mismatch." }, { status: 400 });
      const existing = this.db.query("SELECT peer_instance_id, message_id, filename, content_type, size, sha256 FROM inbound_attachments WHERE transfer_id = ?").get(descriptor.transfer_id) as any;
      if (existing) {
        if (existing.peer_instance_id !== peer.instance_id || existing.message_id !== messageId || existing.filename !== descriptor.filename || existing.content_type !== descriptor.content_type || existing.sha256 !== descriptor.sha256 || existing.size !== descriptor.size) return Response.json({ error: "Attachment transfer id was reused for different content." }, { status: 409 });
        return Response.json(signedAttachmentReceipt(this.identity, descriptor));
      }
      const pending = Number((this.db.query("SELECT COALESCE(SUM(size), 0) AS size FROM inbound_attachments WHERE peer_instance_id = ?").get(peer.instance_id) as { size: number }).size || 0);
      if (pending + descriptor.size > MAX_PENDING_ATTACHMENT_BYTES_PER_PEER) return Response.json({ error: "Peer attachment staging limit exceeded." }, { status: 413 });
      const bytes = new Uint8Array(readFileSync(tempPath));
      this.db.query(`INSERT INTO inbound_attachments (transfer_id, peer_instance_id, message_id, filename, content_type, size, sha256, data, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(descriptor.transfer_id, peer.instance_id, messageId, descriptor.filename, descriptor.content_type, descriptor.size, descriptor.sha256, bytes, this.now().toISOString());
      return Response.json(signedAttachmentReceipt(this.identity, descriptor));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    } finally {
      try { rmSync(tempPath, { force: true }); } catch { /* best-effort temporary-file cleanup */ }
    }
  }

  claim(peerInstanceId: string, messageId: string, descriptors: RemoteAttachmentDescriptor[]): ReceivedRemoteAttachment[] {
    if (descriptors.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error("Message attachment count exceeds policy.");
    let total = 0;
    const records = descriptors.map((descriptor) => {
      const clean = { ...descriptor, transfer_id: cleanTransferId(descriptor.transfer_id), filename: cleanFilename(descriptor.filename), content_type: cleanContentType(descriptor.content_type), sha256: cleanSha256(descriptor.sha256) };
      const row = this.db.query("SELECT peer_instance_id, message_id, filename, content_type, size, sha256, data, received_at FROM inbound_attachments WHERE transfer_id = ?").get(clean.transfer_id) as any;
      if (!row || row.peer_instance_id !== peerInstanceId || row.message_id !== messageId || row.filename !== clean.filename || row.content_type !== clean.content_type || row.size !== clean.size || row.sha256 !== clean.sha256) throw new Error(`Attachment ${clean.transfer_id} is missing or does not match its descriptor.`);
      total += row.size;
      return { ...clean, data: new Uint8Array(row.data) };
    });
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error("Message attachment total exceeds policy.");
    return records;
  }

  complete(messageId: string): void {
    this.db.query("DELETE FROM inbound_attachments WHERE message_id = ?").run(messageId);
  }
}
