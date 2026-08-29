import { afterEach, describe, expect, test } from "bun:test";
import Database from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRemotePeerStore } from "./store/index.js";
import { createHash } from "node:crypto";
import { LATEST_STORE_SCHEMA_VERSION, STORE_MIGRATIONS, type StoreMigration } from "./store/schema.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "remote-peer-store-"));
  roots.push(root);
  return root;
}

describe("remote-peer store", () => {
  test("creates and validates the complete relational schema", () => {
    const root = tempRoot();
    const store = openRemotePeerStore(root);
    const version = store.db.query("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    expect(version.version).toBe(LATEST_STORE_SCHEMA_VERSION);
    const tables = (store.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
    for (const name of [
      "addon_config", "advertised_agents", "callback_attempts", "inbound_messages", "message_receipts",
      "outbound_messages", "pair_inbound", "pair_outbound", "peers", "proposal_requests", "schema_migrations", "transport_audit",
    ]) expect(tables).toContain(name);
    const inboundColumns = (store.db.query("PRAGMA table_info(inbound_messages)").all() as Array<{ name: string }>).map(column => column.name);
    expect(inboundColumns).toContain("receipt_json");
    const advertisedColumns = (store.db.query("PRAGMA table_info(advertised_agents)").all() as Array<{ name: string }>).map(column => column.name);
    expect(advertisedColumns).toContain("local_agent_name");
    expect(tables).toContain("reply_tokens");
    expect(tables).toContain("peer_agent_permissions");
    expect(tables).toContain("capability_profiles");
    const proposalColumns = (store.db.query("PRAGMA table_info(proposal_requests)").all() as Array<{ name: string }>).map(column => column.name);
    expect(proposalColumns).toContain("origin_chat_jid");
    expect(proposalColumns).toContain("callback_payload_sha256");
    expect((store.db.query("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
    expect((store.db.query("PRAGMA foreign_keys").get() as any).foreign_keys).toBe(1);
    store.integrityCheck();
    store.close();
  });

  test("persists normalized config across reopen", () => {
    const root = tempRoot();
    const first = openRemotePeerStore(root);
    expect(first.loadConfig().enabled).toBe(false);
    first.saveConfig({
      enabled: true,
      instanceName: "Lab",
      externalUrl: "https://lab.example.test",
      allowHttp: false,
      allowPrivateNetwork: false,
    });
    first.close();
    const second = openRemotePeerStore(root);
    expect(second.loadConfig()).toMatchObject({ enabled: true, instanceName: "Lab" });
    second.close();
  });

  test("enforces peer and message uniqueness and foreign keys", () => {
    const root = tempRoot();
    const store = openRemotePeerStore(root);
    const now = new Date().toISOString();
    store.db.query(`INSERT INTO peers (
      instance_id, peer_alias, public_key, fingerprint, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'paired', ?, ?)`)
      .run("peer-1", "lab", "public", "fingerprint", now, now);
    expect(() => store.db.query(`INSERT INTO peers (
      instance_id, peer_alias, public_key, fingerprint, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'paired', ?, ?)`)
      .run("peer-2", "lab", "other", "other-fingerprint", now, now)).toThrow();
    expect(() => store.db.query(`INSERT INTO inbound_messages (
      peer_instance_id, message_id, target_agent_name, mode, content_sha256, status, received_at, updated_at
    ) VALUES (?, ?, 'inbox', 'queue', 'hash', 'queued', ?, ?)`)
      .run("missing-peer", "message-1", now, now)).toThrow();
    store.close();
  });

  test("creates an online backup before an upgrade and applies the next migration", () => {
    const root = tempRoot();
    const initial = openRemotePeerStore(root);
    initial.close();
    const sql = "CREATE TABLE migration_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);";
    const nextVersion = STORE_MIGRATIONS.at(-1)!.version + 1;
    const next: StoreMigration = {
      version: nextVersion,
      name: "probe",
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql,
    };
    const upgraded = openRemotePeerStore(root, { migrations: [...STORE_MIGRATIONS, next] });
    expect((upgraded.db.query("SELECT MAX(version) AS version FROM schema_migrations").get() as any).version).toBe(nextVersion);
    expect((upgraded.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_probe'").get() as any).name).toBe("migration_probe");
    upgraded.close();
    const backups = readdirSync(join(root, "backups")).filter(name => name.endsWith(".db"));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(root, "backups", backups[0]), { readonly: true });
    expect((backup.query("SELECT MAX(version) AS version FROM schema_migrations").get() as any).version).toBe(nextVersion - 1);
    expect(backup.query("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_probe'").get()).toBeNull();
    backup.close();
  });

  test("refuses migration checksum drift", () => {
    const root = tempRoot();
    const initial = openRemotePeerStore(root);
    initial.close();
    const raw = new Database(join(root, "state.db"));
    raw.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    raw.close();
    expect(() => openRemotePeerStore(root)).toThrow("checksum mismatch");
    expect(existsSync(join(root, "state.db"))).toBe(true);
  });

  test("normal close checkpoints WAL and is idempotent", () => {
    const root = tempRoot();
    const store = openRemotePeerStore(root);
    store.close();
    store.close();
    expect(readdirSync(root)).toContain("state.db");
  });
});
