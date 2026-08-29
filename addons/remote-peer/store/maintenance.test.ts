import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRemotePeerStore } from "./index.js";
import { runRemotePeerMaintenance } from "./maintenance.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

test("maintenance expires capabilities, prunes old ledgers, and redacts terminal prompts", () => {
  const root = mkdtempSync(join(tmpdir(), "remote-peer-maintenance-"));
  roots.push(root);
  const store = openRemotePeerStore(root);
  const old = "2025-01-01T00:00:00.000Z";
  const now = new Date("2026-07-28T00:00:00.000Z");
  store.db.query(`INSERT INTO peers (instance_id, peer_alias, public_key, fingerprint, status, created_at, updated_at)
    VALUES ('peer-one', 'peer', 'public', 'fingerprint', 'paired', ?, ?)`)
    .run(old, old);
  store.db.query(`INSERT INTO reply_tokens (token_hash, peer_instance_id, target_chat_jid, expires_at, created_at)
    VALUES ('hash', 'peer-one', 'web:secret', ?, ?)`)
    .run(old, old);
  store.db.query(`INSERT INTO callback_attempts (peer_instance_id, request_id, callback_type, attempt, status, created_at, updated_at)
    VALUES ('peer-one', 'work-one', 'result', 1, 'delivered', ?, ?)`)
    .run(old, old);
  store.db.query(`INSERT INTO transport_audit (peer_instance_id, event, outcome, created_at)
    VALUES ('peer-one', 'test', 'ok', ?)`)
    .run(old);
  store.db.query(`INSERT INTO proposal_requests (
    id, peer_instance_id, direction, status, request_type, prompt_sha256, prompt, completed_at, created_at, updated_at
  ) VALUES ('work-one', 'peer-one', 'outbound', 'completed', 'proposal', 'sha', 'sensitive prompt', ?, ?, ?)`)
    .run(old, old, old);

  store.db.query(`INSERT INTO outbound_messages (peer_instance_id, message_id, target_address, mode, content_sha256, content, status, error, created_at, updated_at)
    VALUES ('peer-one', 'rmsg_failed_file_1234', 'peer!inbox', 'queue', ?, 'failed file', 'failed', 'offline', ?, ?)`)
    .run("b".repeat(64), old, old);
  store.db.query(`INSERT INTO outbound_attachments (transfer_id, message_id, filename, content_type, size, sha256, data, created_at)
    VALUES ('rfile_failed_file_1234', 'rmsg_failed_file_1234', 'failed.txt', 'text/plain', 3, ?, ?, ?)`)
    .run("b".repeat(64), new TextEncoder().encode("old"), old);
  store.db.query(`INSERT INTO inbound_attachments (transfer_id, peer_instance_id, message_id, filename, content_type, size, sha256, data, received_at)
    VALUES ('rfile_old_attachment_1234', 'peer-one', 'rmsg_old_attachment_1234', 'old.txt', 'text/plain', 3, ?, ?, ?)`)
    .run("a".repeat(64), new TextEncoder().encode("old"), old);

  expect(runRemotePeerMaintenance(store.db, now)).toEqual({
    expired_reply_tokens: 1,
    old_callback_attempts: 1,
    old_audit_rows: 1,
    redacted_work_prompts: 1,
    orphaned_attachments: 1,
    old_outbound_attachment_data: 1,
  });
  expect((store.db.query("SELECT prompt, prompt_sha256 FROM proposal_requests WHERE id = 'work-one'").get() as any)).toEqual({ prompt: null, prompt_sha256: "sha" });
  store.close();
});
