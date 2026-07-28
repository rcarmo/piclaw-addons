import type Database from "bun:sqlite";

export type WorkDirection = "inbound" | "outbound";
export type WorkStatus = "pending" | "approved" | "rejected" | "completed" | "failed" | "callback-pending";

export interface WorkRecord {
  id: string;
  peer_instance_id: string;
  direction: WorkDirection;
  status: WorkStatus;
  request_type: "proposal" | "execute";
  prompt_sha256: string;
  prompt: string | null;
  capability_profile: string;
  requested_capabilities_json: string;
  allowed_capabilities_json: string;
  chain_id: string | null;
  chain_hop: number;
  callback_url: string | null;
  origin_chat_jid: string | null;
  origin_thread_id: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  callback_received_at: string | null;
  callback_payload_sha256: string | null;
}

export interface CapabilityProfile {
  name: string;
  allowed_capabilities_json: string;
  max_chain_hops: number;
  enabled: number;
  updated_at: string;
}

export interface CallbackAttempt {
  id: number;
  peer_instance_id: string;
  request_id: string;
  callback_type: string;
  attempt: number;
  status: string;
  error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export class WorkRepository {
  constructor(private readonly db: Database) {}

  get(id: string): WorkRecord | null {
    return this.db.query("SELECT * FROM proposal_requests WHERE id = ?").get(id) as WorkRecord | null;
  }

  list(direction?: WorkDirection, status?: WorkStatus, limit = 100): WorkRecord[] {
    if (direction && status) return this.db.query("SELECT * FROM proposal_requests WHERE direction = ? AND status = ? ORDER BY created_at DESC LIMIT ?").all(direction, status, limit) as WorkRecord[];
    if (direction) return this.db.query("SELECT * FROM proposal_requests WHERE direction = ? ORDER BY created_at DESC LIMIT ?").all(direction, limit) as WorkRecord[];
    if (status) return this.db.query("SELECT * FROM proposal_requests WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit) as WorkRecord[];
    return this.db.query("SELECT * FROM proposal_requests ORDER BY created_at DESC LIMIT ?").all(limit) as WorkRecord[];
  }

  create(record: WorkRecord): void {
    this.db.query(`INSERT INTO proposal_requests (
      id, peer_instance_id, direction, status, request_type, prompt_sha256, prompt, capability_profile,
      requested_capabilities_json, allowed_capabilities_json, chain_id, chain_hop, callback_url,
      origin_chat_jid, origin_thread_id, result, error, created_at, updated_at, completed_at,
      callback_received_at, callback_payload_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.peer_instance_id, record.direction, record.status, record.request_type,
        record.prompt_sha256, record.prompt, record.capability_profile, record.requested_capabilities_json,
        record.allowed_capabilities_json, record.chain_id, record.chain_hop, record.callback_url,
        record.origin_chat_jid, record.origin_thread_id, record.result, record.error, record.created_at,
        record.updated_at, record.completed_at, record.callback_received_at, record.callback_payload_sha256);
  }

  decide(id: string, expected: WorkStatus, next: WorkStatus, result: string | null, error: string | null, allowedJson: string, now: string): boolean {
    return this.db.query(`UPDATE proposal_requests SET status = ?, result = ?, error = ?,
      allowed_capabilities_json = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status = ?`)
      .run(next, result, error, allowedJson, now, now, id, expected).changes === 1;
  }

  markCallbackDelivered(id: string, expected: WorkStatus, next: WorkStatus, now: string): boolean {
    return this.db.query("UPDATE proposal_requests SET status = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status = ?")
      .run(next, now, now, id, expected).changes === 1;
  }

  markCallbackReceived(id: string, status: WorkStatus, result: string | null, error: string | null, allowedJson: string, payloadHash: string, now: string): boolean {
    return this.db.query(`UPDATE proposal_requests SET status = ?, result = ?, error = ?, allowed_capabilities_json = ?, updated_at = ?,
      completed_at = ?, callback_received_at = ?, callback_payload_sha256 = ?
      WHERE id = ? AND direction = 'outbound' AND callback_received_at IS NULL`)
      .run(status, result, error, allowedJson, now, now, now, payloadHash, id).changes === 1;
  }

  createCallbackAttempt(peerInstanceId: string, requestId: string, callbackType: string, attempt: number, status: string, error: string | null, nextAttemptAt: string | null, now: string): void {
    this.db.query(`INSERT INTO callback_attempts (
      peer_instance_id, request_id, callback_type, attempt, status, error, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(peerInstanceId, requestId, callbackType, attempt, status, error, nextAttemptAt, now, now);
  }

  nextCallbackAttempt(requestId: string): number {
    return Number((this.db.query("SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM callback_attempts WHERE request_id = ?").get(requestId) as { attempt: number }).attempt);
  }

  listDueCallbacks(now: string, limit = 50): CallbackAttempt[] {
    return this.db.query(`SELECT c.* FROM callback_attempts c
      JOIN (SELECT request_id, callback_type, MAX(attempt) AS max_attempt FROM callback_attempts GROUP BY request_id, callback_type) latest
        ON latest.request_id = c.request_id AND latest.callback_type = c.callback_type AND latest.max_attempt = c.attempt
      WHERE c.status = 'failed' AND c.next_attempt_at <= ? ORDER BY c.next_attempt_at LIMIT ?`)
      .all(now, limit) as CallbackAttempt[];
  }

  getProfile(name: string): CapabilityProfile | null {
    return this.db.query("SELECT * FROM capability_profiles WHERE name = ? AND enabled = 1").get(name) as CapabilityProfile | null;
  }

  listProfiles(): CapabilityProfile[] {
    return this.db.query("SELECT * FROM capability_profiles ORDER BY name").all() as CapabilityProfile[];
  }

  upsertProfile(name: string, capabilities: string[], maxChainHops: number, enabled: boolean, now: string): CapabilityProfile {
    this.db.query(`INSERT INTO capability_profiles (name, allowed_capabilities_json, max_chain_hops, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET allowed_capabilities_json=excluded.allowed_capabilities_json,
      max_chain_hops=excluded.max_chain_hops, enabled=excluded.enabled, updated_at=excluded.updated_at`)
      .run(name, JSON.stringify([...new Set(capabilities)]), maxChainHops, enabled ? 1 : 0, now);
    return this.db.query("SELECT * FROM capability_profiles WHERE name = ?").get(name) as CapabilityProfile;
  }
}
