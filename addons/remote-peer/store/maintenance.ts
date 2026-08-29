import type Database from "bun:sqlite";

const DAY_MS = 24 * 60 * 60_000;

export interface MaintenanceResult {
  expired_reply_tokens: number;
  old_callback_attempts: number;
  old_audit_rows: number;
  redacted_work_prompts: number;
  orphaned_attachments: number;
  old_outbound_attachment_data: number;
}

export function runRemotePeerMaintenance(db: Database, now = new Date()): MaintenanceResult {
  const nowIso = now.toISOString();
  const callbackCutoff = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const auditCutoff = new Date(now.getTime() - 90 * DAY_MS).toISOString();
  const promptCutoff = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  return db.transaction(() => ({
    expired_reply_tokens: db.query("DELETE FROM reply_tokens WHERE expires_at < ?").run(nowIso).changes,
    old_callback_attempts: db.query("DELETE FROM callback_attempts WHERE status = 'delivered' AND updated_at < ?").run(callbackCutoff).changes,
    old_audit_rows: db.query("DELETE FROM transport_audit WHERE created_at < ?").run(auditCutoff).changes,
    redacted_work_prompts: db.query(`UPDATE proposal_requests SET prompt = NULL
      WHERE prompt IS NOT NULL AND status IN ('completed', 'rejected', 'failed') AND completed_at < ?`).run(promptCutoff).changes,
    orphaned_attachments: db.query("DELETE FROM inbound_attachments WHERE received_at < ?").run(new Date(now.getTime() - DAY_MS).toISOString()).changes,
    old_outbound_attachment_data: db.query(`DELETE FROM outbound_attachments WHERE message_id IN (
      SELECT message_id FROM outbound_messages WHERE status = 'failed' AND updated_at < ?
    )`).run(new Date(now.getTime() - 7 * DAY_MS).toISOString()).changes,
  })).immediate();
}
