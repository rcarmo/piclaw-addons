import type Database from "bun:sqlite";

export interface PeerRecord {
  instance_id: string;
  peer_alias: string;
  public_key: string;
  fingerprint: string;
  display_name: string | null;
  base_url: string | null;
  status: "pending" | "paired" | "blocked" | "revoked";
  trust_epoch: number;
  messaging_scope: string;
  mode_ceiling: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  blocked_reason: string | null;
  attachments_enabled?: number;
  max_attachment_bytes?: number;
}

export interface InboundPairRecord {
  id: string;
  instance_id: string;
  public_key: string;
  fingerprint: string;
  display_name: string | null;
  callback_url: string;
  protocol_version: number;
  nonce: string;
  status: string;
  source_key: string | null;
  trust_epoch: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface OutboundPairRecord {
  id: string;
  instance_id: string;
  public_key: string;
  fingerprint: string;
  base_url: string;
  nonce: string;
  status: string;
  trust_epoch: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export class PairingRepository {
  constructor(private readonly db: Database) {}

  listPeers(status?: string): PeerRecord[] {
    return status
      ? this.db.query("SELECT * FROM peers WHERE status = ? ORDER BY updated_at DESC").all(status) as PeerRecord[]
      : this.db.query("SELECT * FROM peers ORDER BY updated_at DESC").all() as PeerRecord[];
  }

  getPeer(instanceId: string): PeerRecord | null {
    return this.db.query("SELECT * FROM peers WHERE instance_id = ?").get(instanceId) as PeerRecord | null;
  }

  getPeerByAlias(alias: string): PeerRecord | null {
    return this.db.query("SELECT * FROM peers WHERE peer_alias = ? COLLATE NOCASE").get(alias) as PeerRecord | null;
  }

  getPeerByFingerprint(fingerprint: string): PeerRecord | null {
    return this.db.query("SELECT * FROM peers WHERE fingerprint = ?").get(fingerprint) as PeerRecord | null;
  }

  getPeerByBaseUrl(value: string): PeerRecord | null {
    return this.db.query("SELECT * FROM peers WHERE base_url = ? ORDER BY updated_at DESC LIMIT 1").get(value) as PeerRecord | null;
  }

  resolvePeer(reference: string): PeerRecord | null {
    return this.getPeer(reference) ?? this.getPeerByFingerprint(reference) ?? this.getPeerByAlias(reference);
  }

  upsertPeer(peer: PeerRecord): void {
    this.db.query(`INSERT INTO peers (
      instance_id, peer_alias, public_key, fingerprint, display_name, base_url, status, trust_epoch,
      messaging_scope, mode_ceiling, created_at, updated_at, last_seen_at, blocked_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      peer_alias=excluded.peer_alias, public_key=excluded.public_key, fingerprint=excluded.fingerprint,
      display_name=excluded.display_name, base_url=excluded.base_url, status=excluded.status,
      trust_epoch=excluded.trust_epoch, messaging_scope=excluded.messaging_scope,
      mode_ceiling=excluded.mode_ceiling, updated_at=excluded.updated_at,
      last_seen_at=excluded.last_seen_at, blocked_reason=excluded.blocked_reason`)
      .run(peer.instance_id, peer.peer_alias, peer.public_key, peer.fingerprint, peer.display_name, peer.base_url,
        peer.status, peer.trust_epoch, peer.messaging_scope, peer.mode_ceiling, peer.created_at, peer.updated_at,
        peer.last_seen_at, peer.blocked_reason);
  }

  updatePeer(instanceId: string, updates: Pick<PeerRecord, "status" | "trust_epoch" | "updated_at" | "last_seen_at" | "blocked_reason">): void {
    this.db.query(`UPDATE peers SET status=?, trust_epoch=?, updated_at=?, last_seen_at=?, blocked_reason=? WHERE instance_id=?`)
      .run(updates.status, updates.trust_epoch, updates.updated_at, updates.last_seen_at, updates.blocked_reason, instanceId);
  }

  updatePeerAttachmentPolicy(instanceId: string, enabled: boolean, maxBytes: number, updatedAt: string): PeerRecord {
    if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 16 * 1024 * 1024) throw new Error("Attachment limit must be 0-16777216 bytes.");
    this.db.query("UPDATE peers SET attachments_enabled = ?, max_attachment_bytes = ?, updated_at = ? WHERE instance_id = ?")
      .run(enabled ? 1 : 0, maxBytes, updatedAt, instanceId);
    const peer = this.getPeer(instanceId);
    if (!peer) throw new Error("Peer not found.");
    return peer;
  }

  updatePeerAlias(instanceId: string, alias: string, updatedAt: string): void {
    this.db.query("UPDATE peers SET peer_alias = ?, updated_at = ? WHERE instance_id = ?")
      .run(alias, updatedAt, instanceId);
  }

  createInbound(record: InboundPairRecord): void {
    this.db.query(`INSERT INTO pair_inbound (
      id, instance_id, public_key, fingerprint, display_name, callback_url, protocol_version, nonce,
      status, source_key, trust_epoch, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.instance_id, record.public_key, record.fingerprint, record.display_name,
        record.callback_url, record.protocol_version, record.nonce, record.status, record.source_key,
        record.trust_epoch, record.expires_at, record.created_at, record.updated_at);
  }

  getInbound(id: string): InboundPairRecord | null {
    return this.db.query("SELECT * FROM pair_inbound WHERE id = ?").get(id) as InboundPairRecord | null;
  }

  listInbound(status = "pending"): InboundPairRecord[] {
    return this.db.query("SELECT * FROM pair_inbound WHERE status = ? ORDER BY created_at DESC").all(status) as InboundPairRecord[];
  }

  updateInbound(id: string, status: string): void {
    this.db.query("UPDATE pair_inbound SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
  }

  createOutbound(record: OutboundPairRecord): void {
    this.db.query(`INSERT INTO pair_outbound (
      id, instance_id, public_key, fingerprint, base_url, nonce, status, trust_epoch, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.instance_id, record.public_key, record.fingerprint, record.base_url, record.nonce,
        record.status, record.trust_epoch, record.expires_at, record.created_at, record.updated_at);
  }

  getOutbound(id: string): OutboundPairRecord | null {
    return this.db.query("SELECT * FROM pair_outbound WHERE id = ?").get(id) as OutboundPairRecord | null;
  }

  updateOutbound(id: string, status: string): void {
    this.db.query("UPDATE pair_outbound SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
  }

  audit(peerInstanceId: string | null, event: string, outcome: string, error?: string, metadata?: unknown): void {
    this.db.query(`INSERT INTO transport_audit (peer_instance_id, event, outcome, error, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(peerInstanceId, event, outcome, error ?? null, metadata === undefined ? null : JSON.stringify(metadata), new Date().toISOString());
  }
}
