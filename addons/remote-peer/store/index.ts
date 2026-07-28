import Database from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeRemotePeerConfig, type RemotePeerConfig } from "../config.js";
import {
  ensureMigrationTable,
  readAppliedMigrations,
  STORE_MIGRATIONS,
  type StoreMigration,
} from "./schema.js";

const MAX_MIGRATION_BACKUPS = 3;

export interface RemotePeerStore {
  db: Database;
  dbPath: string;
  dataDir: string;
  loadConfig(): RemotePeerConfig;
  saveConfig(config: RemotePeerConfig): RemotePeerConfig;
  integrityCheck(): void;
  close(): void;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function migrationBackupPath(dataDir: string, currentVersion: number, targetVersion: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dataDir, "backups", `${stamp}_schema-${currentVersion}-to-${targetVersion}.db`);
}

function pruneBackups(dataDir: string): void {
  const backupDir = join(dataDir, "backups");
  if (!existsSync(backupDir)) return;
  const backups = readdirSync(backupDir)
    .filter((name) => name.endsWith(".db"))
    .sort()
    .reverse();
  for (const old of backups.slice(MAX_MIGRATION_BACKUPS)) {
    rmSync(join(backupDir, old), { force: true });
  }
}

function createMigrationBackup(db: Database, dataDir: string, currentVersion: number, targetVersion: number): string | null {
  if (currentVersion === 0 || !existsSync(join(dataDir, "state.db"))) return null;
  const path = migrationBackupPath(dataDir, currentVersion, targetVersion);
  mkdirSync(join(dataDir, "backups"), { recursive: true });
  db.exec(`VACUUM INTO ${sqlString(path)}`);
  pruneBackups(dataDir);
  return path;
}

function applyMigrations(db: Database, dataDir: string, migrations: readonly StoreMigration[]): void {
  ensureMigrationTable(db);
  const applied = readAppliedMigrations(db);
  const latestApplied = applied.at(-1)?.version ?? 0;
  const latestSupported = migrations.at(-1)?.version ?? 0;
  if (latestApplied > latestSupported) {
    throw new Error(`Remote-peer database schema ${latestApplied} is newer than supported ${latestSupported}.`);
  }

  for (const record of applied) {
    const known = migrations.find((migration) => migration.version === record.version);
    if (!known || known.name !== record.name || known.checksum !== record.checksum) {
      throw new Error(`Remote-peer database migration checksum mismatch at version ${record.version}.`);
    }
  }

  const pending = migrations.filter((migration) => migration.version > latestApplied);
  if (pending.length === 0) return;
  createMigrationBackup(db, dataDir, latestApplied, pending.at(-1)!.version);

  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.query(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    }).immediate();
  }
}

function assertIntegrity(db: Database): void {
  const integrity = db.query("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error(`Remote-peer database integrity check failed: ${JSON.stringify(integrity)}`);
  }
  const foreignKeys = db.query("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new Error(`Remote-peer database foreign-key check failed: ${JSON.stringify(foreignKeys)}`);
  }
}

export function openRemotePeerStore(
  dataDir: string,
  options: { migrations?: readonly StoreMigration[] } = {},
): RemotePeerStore {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "state.db");
  const db = new Database(dbPath, { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA secure_delete = ON");
    const migrations = options.migrations ?? STORE_MIGRATIONS;
    applyMigrations(db, dataDir, migrations);
    assertIntegrity(db);
  } catch (error) {
    db.close(false);
    throw error;
  }

  let closed = false;
  return {
    db,
    dbPath,
    dataDir,
    loadConfig(): RemotePeerConfig {
      const row = db.query("SELECT value_json FROM addon_config WHERE key = 'config'").get() as { value_json: string } | null;
      return normalizeRemotePeerConfig(row ? JSON.parse(row.value_json) : {});
    },
    saveConfig(config: RemotePeerConfig): RemotePeerConfig {
      const normalized = normalizeRemotePeerConfig(config);
      db.query(`
        INSERT INTO addon_config (key, value_json, updated_at) VALUES ('config', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(JSON.stringify(normalized), new Date().toISOString());
      return normalized;
    },
    integrityCheck(): void {
      assertIntegrity(db);
    },
    close(): void {
      if (closed) return;
      closed = true;
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(false); }
    },
  };
}
