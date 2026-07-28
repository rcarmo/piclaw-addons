import { createHash } from "node:crypto";
import type Database from "bun:sqlite";
import { INITIAL_SCHEMA_SQL } from "./migrations/0001-initial.js";
import { PAIR_TRUST_EPOCHS_SQL } from "./migrations/0002-pair-trust-epochs.js";
import { MESSAGE_RECEIPTS_SQL } from "./migrations/0003-message-receipts.js";
import { ROSTER_REPLIES_SQL } from "./migrations/0004-roster-replies.js";

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
  Object.freeze({
    version: 2,
    name: "pair-trust-epochs",
    checksum: checksum(PAIR_TRUST_EPOCHS_SQL),
    sql: PAIR_TRUST_EPOCHS_SQL,
  }),
  Object.freeze({
    version: 3,
    name: "message-receipts",
    checksum: checksum(MESSAGE_RECEIPTS_SQL),
    sql: MESSAGE_RECEIPTS_SQL,
  }),
  Object.freeze({
    version: 4,
    name: "roster-replies",
    checksum: checksum(ROSTER_REPLIES_SQL),
    sql: ROSTER_REPLIES_SQL,
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
