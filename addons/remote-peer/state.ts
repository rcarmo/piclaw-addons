import Database, { constants } from "bun:sqlite";
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
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { normalizeRemotePeerConfig, type RemotePeerConfig } from "./config.js";
export type Mode = "queue" | "auto" | "steer";
export interface SessionGrant {
  agent: string;
  session_alias: string;
  revision?: string; // Legacy saved grants have no revision and are not usable.
  modes: Mode[];
}
export interface AdvertisedSession {
  revision: string;
  agent: string;
  session_alias: string;
  local_agent: string;
  chat_jid: string;
  incarnation: string;
  modes: string;
}
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
  sessions?: SessionGrant[];
  files: boolean;
  lastSeen: number | null;
}
export class PeerState {
  readonly db: Database;
  readonly dir: string;
  keyBytes: number[];
  private readonly lifetime = new AbortController();
  private readonly path: string;
  private identity!: string;
  constructor(base: string, private onAuthorizationChange?: (peerId: string) => void, private assertWriteCurrent?: () => void) {
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
    const path = this.path = join(this.dir, "peers.db");
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error("Peer database must not be a symlink.");
    this.db = new Database(path, { create: true });
    try {
    this.db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peers(id TEXT PRIMARY KEY,alias TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS advertised(alias TEXT PRIMARY KEY,local_agent TEXT NOT NULL,modes TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS advertised_sessions(agent TEXT NOT NULL,session_alias TEXT NOT NULL,local_agent TEXT NOT NULL,chat_jid TEXT NOT NULL,incarnation TEXT NOT NULL,modes TEXT NOT NULL,PRIMARY KEY(agent,session_alias));
      CREATE TABLE IF NOT EXISTS outbound(id TEXT PRIMARY KEY,peer TEXT NOT NULL,idem TEXT,payload TEXT NOT NULL,bytes BLOB,status TEXT NOT NULL,receipt TEXT,error TEXT,created INTEGER NOT NULL,UNIQUE(peer,idem));
      CREATE TABLE IF NOT EXISTS inbound(peer TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,PRIMARY KEY(peer,id));
      CREATE TABLE IF NOT EXISTS replies(token TEXT PRIMARY KEY,peer TEXT NOT NULL,epoch TEXT NOT NULL,target TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,kind TEXT NOT NULL,peer TEXT,detail TEXT);
      CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY,peer TEXT NOT NULL,direction TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);`);
    // Upgrade the unpublished session registry without binding legacy grants
    // to an advertisement they never explicitly selected.
    if (!(this.db.query("PRAGMA table_info(advertised_sessions)").all() as { name: string }[]).some((column) => column.name === "revision")) {
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE advertised_sessions ADD COLUMN revision TEXT NOT NULL DEFAULT ''");
        for (const row of this.db.query("SELECT agent,session_alias FROM advertised_sessions").all() as { agent: string; session_alias: string }[])
          this.db.query("UPDATE advertised_sessions SET revision=? WHERE agent=? AND session_alias=?").run(randomUUID(), row.agent, row.session_alias);
      }).immediate();
    }
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
    const file = statSync(path); this.identity = `${file.dev}:${file.ino}`;
    } catch (error) { this.db.close(); throw error; }
  }
  /** Retry only BEGIN acquisition. A synchronous SQL body is entered at most
   * once; errors/commit uncertainty never replay it or a transport operation. */
  async write<T>(body: () => T, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
    const timeout = options.timeoutMs ?? 5000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw Error('Peer storage timeout must be finite and positive.');
    const deadline = performance.now() + timeout;
    const check = (authority = true) => {
      signal.throwIfAborted(); if (authority) this.assertWriteCurrent?.();
      const file = lstatSync(this.path), moved = new Int32Array(2);
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || `${file.dev}:${file.ino}` !== this.identity ||
          this.db.fileControl('main', constants.SQLITE_FCNTL_HAS_MOVED, moved) !== 0 || moved[0] !== 0)
        throw Error('Peer database identity changed.');
    };
    while (true) {
      check();
      try { this.db.exec('BEGIN IMMEDIATE'); }
      catch (error) {
        if (!['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String((error as { code?: string }).code))) throw error;
        if (performance.now() >= deadline) throw Object.assign(new Error('Peer state storage acquisition timed out.'), { code: 'PEER_STATE_BUSY', certainty: 'not_applied', retryable: true });
        await new Promise<void>((resolve, reject) => {
          const aborted = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, Math.min(25, Math.max(0, deadline - performance.now())));
          signal.addEventListener('abort', aborted, { once: true });
        });
        continue;
      }
      try {
        check(); const value = body();
        if (value && typeof (value as { then?: unknown }).then === 'function') throw Error('Peer SQL mutation must be synchronous.');
        // An authorised revocation may invalidate its own peer grant. Keep the
        // lifetime/file fence, but do not undo that effect by re-admitting it.
        check(false); this.db.exec('COMMIT'); return value;
      } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
    }
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
    const previous = this.peer(peer.id);
    const authorization = (p: Peer) => JSON.stringify([p.status, p.epoch, p.scope, p.modes, p.agents, p.sessions ?? [], p.files]);
    const changed = !previous || authorization(previous) !== authorization(peer);
    if (changed) {
      this.db.query("INSERT OR REPLACE INTO settings VALUES (?,?)").run("grant-epoch:" + peer.id, randomUUID());
      this.onAuthorizationChange?.(peer.id);
    }
    this.db
      .query(
        "INSERT INTO peers VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET alias=excluded.alias,data=excluded.data",
      )
      .run(peer.id, peer.alias, JSON.stringify(peer));
  }
  authorizationEpoch(peerId: string): string | null {
    const row = this.db.query("SELECT value FROM settings WHERE key=?").get("grant-epoch:" + peerId) as { value: string } | null;
    return row?.value ?? null;
  }
  assertIdentityRotationAllowed(): void {
    if (this.peers().some((peer) => peer.status !== "revoked"))
      throw new Error(
        "Revoke every peer and cancel every pending request before rotating identity.",
      );
  }
  async rotateIdentity(): Promise<number[]> {
    const keyPath = join(this.dir, "secret-key.bin"),
      temporary = join(
        this.dir,
        `.secret-key.${process.pid}.${Date.now()}.tmp`,
      );
    const bytes = randomBytes(32);
    // Clear all authorization and delivery state before publishing the new key.
    // A crash before rename keeps the old identity with empty trust; a crash
    // after rename leaves the new identity with empty trust.
    await this.write(() => {
        this.assertIdentityRotationAllowed();
        for (const table of [
          "peers",
          "advertised",
          "advertised_sessions",
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
      });
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
      await this.write(() => this.db
        .query("INSERT INTO audit(at,kind,peer,detail) VALUES (?,?,NULL,?)")
        .run(
          Date.now(),
          "identity-rotated",
          "Fresh Iroh key installed; explicit new pairing required",
        ));
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
    this.lifetime.abort(new Error('Peer state closed.'));
    this.db.close();
  }
}
