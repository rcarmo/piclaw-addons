import { createHash } from "node:crypto";
import type Database from "bun:sqlite";
import { INITIAL_SCHEMA_SQL } from "./migrations/0001-initial.js";

export interface StoreMigration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const STORE_MIGRATIONS: readonly StoreMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "initial",
    checksum: checksum(INITIAL_SCHEMA_SQL),
    sql: INITIAL_SCHEMA_SQL,
  }),
]);

export const LATEST_STORE_SCHEMA_VERSION = STORE_MIGRATIONS.at(-1)?.version ?? 0;

export function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function readAppliedMigrations(db: Database): Array<{ version: number; name: string; checksum: string }> {
  return db.query("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as Array<{
    version: number;
    name: string;
    checksum: string;
  }>;
}
