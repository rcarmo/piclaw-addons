import type Database from "bun:sqlite";

export interface OutboundMessageRecord {
  peer_instance_id: string;
  message_id: string;
  idempotency_key: string | null;
  source_agent_name: string | null;
  target_address: string;
  mode: string;
  content_sha256: string;
  status: string;
  receipt_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboundMessageRecord {
  peer_instance_id: string;
  message_id: string;
  idempotency_key: string | null;
  target_agent_name: string;
  mode: string;
  content_sha256: string;
  status: string;
  local_row_id: number | null;
  receipt_json: string | null;
  received_at: string;
  updated_at: string;
}

export class MessagingRepository {
  constructor(private readonly db: Database) {}

  getOutboundByMessageId(messageId: string): OutboundMessageRecord | null {
    return this.db.query("SELECT * FROM outbound_messages WHERE message_id = ?").get(messageId) as OutboundMessageRecord | null;
  }

  getOutboundByIdempotency(peerInstanceId: string, idempotencyKey: string): OutboundMessageRecord | null {
    return this.db.query("SELECT * FROM outbound_messages WHERE peer_instance_id = ? AND idempotency_key = ?")
      .get(peerInstanceId, idempotencyKey) as OutboundMessageRecord | null;
  }

  findOutbound(messageId: string): OutboundMessageRecord | null {
    return this.getOutboundByMessageId(messageId);
  }

  createOutbound(record: OutboundMessageRecord): void {
    this.db.query(`INSERT INTO outbound_messages (
      peer_instance_id, message_id, idempotency_key, source_agent_name, target_address, mode,
      content_sha256, status, receipt_json, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.peer_instance_id, record.message_id, record.idempotency_key, record.source_agent_name,
        record.target_address, record.mode, record.content_sha256, record.status, record.receipt_json,
        record.error, record.created_at, record.updated_at);
  }

  completeOutbound(messageId: string, status: string, receiptJson: string | null, error: string | null, updatedAt: string): void {
    this.db.query("UPDATE outbound_messages SET status = ?, receipt_json = ?, error = ?, updated_at = ? WHERE message_id = ?")
      .run(status, receiptJson, error, updatedAt, messageId);
  }

  getInbound(peerInstanceId: string, messageId: string): InboundMessageRecord | null {
    return this.db.query("SELECT * FROM inbound_messages WHERE peer_instance_id = ? AND message_id = ?")
      .get(peerInstanceId, messageId) as InboundMessageRecord | null;
  }

  getInboundByIdempotency(peerInstanceId: string, idempotencyKey: string): InboundMessageRecord | null {
    return this.db.query("SELECT * FROM inbound_messages WHERE peer_instance_id = ? AND idempotency_key = ?")
      .get(peerInstanceId, idempotencyKey) as InboundMessageRecord | null;
  }

  findInbound(messageId: string): InboundMessageRecord | null {
    return this.db.query("SELECT * FROM inbound_messages WHERE message_id = ? ORDER BY received_at DESC LIMIT 1")
      .get(messageId) as InboundMessageRecord | null;
  }

  createInbound(record: InboundMessageRecord): void {
    this.db.query(`INSERT INTO inbound_messages (
      peer_instance_id, message_id, idempotency_key, target_agent_name, mode, content_sha256,
      status, local_row_id, receipt_json, received_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.peer_instance_id, record.message_id, record.idempotency_key, record.target_agent_name,
        record.mode, record.content_sha256, record.status, record.local_row_id, record.receipt_json,
        record.received_at, record.updated_at);
  }

  completeInbound(peerInstanceId: string, messageId: string, status: string, localRowId: number | null, receiptJson: string, updatedAt: string): void {
    this.db.query(`UPDATE inbound_messages SET status = ?, local_row_id = ?, receipt_json = ?, updated_at = ?
      WHERE peer_instance_id = ? AND message_id = ?`)
      .run(status, localRowId, receiptJson, updatedAt, peerInstanceId, messageId);
  }

  addReceipt(peerInstanceId: string, messageId: string, status: string, receiptJson: string, receivedAt: string): void {
    this.db.query(`INSERT OR IGNORE INTO message_receipts (
      peer_instance_id, message_id, status, receipt_json, received_at
    ) VALUES (?, ?, ?, ?, ?)`)
      .run(peerInstanceId, messageId, status, receiptJson, receivedAt);
  }

  listOutbound(limit = 50): OutboundMessageRecord[] {
    return this.db.query("SELECT * FROM outbound_messages ORDER BY created_at DESC LIMIT ?").all(limit) as OutboundMessageRecord[];
  }

  listInbound(limit = 50): InboundMessageRecord[] {
    return this.db.query("SELECT * FROM inbound_messages ORDER BY received_at DESC LIMIT ?").all(limit) as InboundMessageRecord[];
  }
}
