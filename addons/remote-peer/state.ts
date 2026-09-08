import Database from "bun:sqlite";
import {
  mkdirSync,
  lstatSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { normalizeRemotePeerConfig, type RemotePeerConfig } from "./config.js";
export type Mode = "queue" | "auto" | "steer";
export interface Peer {
  id: string;
  alias: string;
  name: string;
  status: "outgoing" | "incoming" | "paired" | "revoked";
  request: string;
  expires: number;
  epoch: string;
  ticket: string | null;
  scope: "none" | "inbox-only" | "named-agents" | "all-advertised";
  modes: Mode[];
  agents: string[];
  files: boolean;
  lastSeen: number | null;
}
export class PeerState {
  readonly db: Database;
  readonly dir: string;
  keyBytes: number[];
  constructor(base: string) {
    // Intentionally never reads the old identity.json, state.db or migration ledger.
    this.dir = join(base, "iroh-v1");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (lstatSync(this.dir).isSymbolicLink())
      throw new Error("Peer state must not be a symlink.");
    const key = join(this.dir, "secret-key.bin");
    if (!existsSync(key))
      writeFileSync(key, randomBytes(32), { mode: 0o600, flag: "wx" });
    if (lstatSync(key).isSymbolicLink() || !lstatSync(key).isFile())
      throw new Error("Invalid Iroh key file.");
    const bytes = readFileSync(key);
    if (bytes.length !== 32)
      throw new Error("Invalid Iroh key length; refusing identity reset.");
    chmodSync(key, 0o600);
    this.keyBytes = Array.from(bytes);
    const path = join(this.dir, "peers.db");
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error("Peer database must not be a symlink.");
    this.db = new Database(path, { create: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;",
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peers(id TEXT PRIMARY KEY,alias TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS advertised(alias TEXT PRIMARY KEY,local_agent TEXT NOT NULL,modes TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbound(id TEXT PRIMARY KEY,peer TEXT NOT NULL,idem TEXT,payload TEXT NOT NULL,bytes BLOB,status TEXT NOT NULL,receipt TEXT,error TEXT,created INTEGER NOT NULL,UNIQUE(peer,idem));
      CREATE TABLE IF NOT EXISTS inbound(peer TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,PRIMARY KEY(peer,id));
      CREATE TABLE IF NOT EXISTS replies(token TEXT PRIMARY KEY,peer TEXT NOT NULL,epoch TEXT NOT NULL,target TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,kind TEXT NOT NULL,peer TEXT,detail TEXT);
      CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY,peer TEXT NOT NULL,direction TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);`);
    const version = this.db
      .query("SELECT value FROM settings WHERE key='version'")
      .get() as any;
    if (version && version.value !== "1") {
      this.db.close();
      throw new Error(
        "Unsupported Iroh state version. No migration is available.",
      );
    }
    this.db
      .query("INSERT OR IGNORE INTO settings VALUES ('version','1')")
      .run();
    chmodSync(path, 0o600);
    // Unknown delivery outcome must not be repeated automatically after restart.
    this.db
      .query(
        "UPDATE outbound SET status='failed',error='Interrupted; retry with the same message ID' WHERE status='sending'",
      )
      .run();
    // enqueueAgentMessage has no idempotency key. Never replay a notification
    // that may already have reached the local queue before a process crash.
    this.db
      .query(
        "UPDATE work SET status='notification-unknown' WHERE direction='outbound' AND status='notification-delivering'",
      )
      .run();
  }
  config(): RemotePeerConfig {
    const row = this.db
      .query("SELECT value FROM settings WHERE key='config'")
      .get() as any;
    return normalizeRemotePeerConfig(row ? JSON.parse(row.value) : {});
  }
  saveConfig(value: RemotePeerConfig) {
    const config = normalizeRemotePeerConfig(value);
    this.db
      .query("INSERT OR REPLACE INTO settings VALUES ('config',?)")
      .run(JSON.stringify(config));
    return config;
  }
  peer(id: string): Peer | null {
    const row = this.db
      .query("SELECT data FROM peers WHERE id=? OR alias=?")
      .get(id, id) as any;
    return row ? JSON.parse(row.data) : null;
  }
  peers(): Peer[] {
    return (
      this.db.query("SELECT data FROM peers ORDER BY alias").all() as any[]
    ).map((r) => JSON.parse(r.data));
  }
  put(peer: Peer) {
    this.db
      .query(
        "INSERT INTO peers VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET alias=excluded.alias,data=excluded.data",
      )
      .run(peer.id, peer.alias, JSON.stringify(peer));
  }
  assertIdentityRotationAllowed(): void {
    if (this.peers().some((peer) => peer.status !== "revoked"))
      throw new Error(
        "Revoke every peer and cancel every pending request before rotating identity.",
      );
  }
  rotateIdentity(): number[] {
    this.assertIdentityRotationAllowed();
    const keyPath = join(this.dir, "secret-key.bin"),
      temporary = join(
        this.dir,
        `.secret-key.${process.pid}.${Date.now()}.tmp`,
      );
    const bytes = randomBytes(32);
    // Clear all authorization and delivery state before publishing the new key.
    // A crash before rename keeps the old identity with empty trust; a crash
    // after rename leaves the new identity with empty trust.
    this.db
      .transaction(() => {
        for (const table of [
          "peers",
          "advertised",
          "outbound",
          "inbound",
          "replies",
          "work",
        ])
          this.db.query(`DELETE FROM ${table}`).run();
        this.db
          .query("INSERT INTO audit(at,kind,peer,detail) VALUES (?,?,NULL,?)")
          .run(
            Date.now(),
            "identity-rotation-started",
            "Fresh trust and queue state cleared before key replacement",
          );
      })
      .immediate();
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, keyPath);
      chmodSync(keyPath, 0o600);
      // The installed key is authoritative even if the following directory
      // fsync or audit record fails.
      this.keyBytes = Array.from(bytes);
      const dirFd = openSync(this.dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (error) {
      if (fd !== undefined)
        try {
          closeSync(fd);
        } catch {}
      rmSync(temporary, { force: true });
      throw error;
    }
    try {
      this.db
        .query("INSERT INTO audit(at,kind,peer,detail) VALUES (?,?,NULL,?)")
        .run(
          Date.now(),
          "identity-rotated",
          "Fresh Iroh key installed; explicit new pairing required",
        );
    } catch {
      // Key and cleared authorization state are already durable. Audit failure
      // must not roll in-memory identity back to a stale key.
    }
    return [...this.keyBytes];
  }
  audit(kind: string, peer: string | null, detail: string) {
    this.db
      .query("INSERT INTO audit(at,kind,peer,detail) VALUES (?,?,?,?)")
      .run(Date.now(), kind, peer, detail.slice(0, 1000));
  }
  close() {
    this.db.close();
  }
}
