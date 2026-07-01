/**
 * store/messages.ts
 *
 * Persists voice conversation turns to the piclaw SQLite DB under the
 * `tts:default` JID so they show up in the message store.
 *
 * NOTE: piclaw exposes no public message-insertion API to extensions, so this
 * writes the DB directly. To stay safe (#5):
 *   - the DB is opened lazily on first write (never at import/init time);
 *   - it uses only long-stable columns present in every schema revision;
 *   - every write is wrapped in try/catch and is non-fatal — a failure logs
 *     once and disables further writes rather than throwing into the pipeline.
 * If a public insertion API becomes available, prefer it over this module.
 */

import { Database } from "bun:sqlite";

let _db: Database | null = null;
let _disabled = false;

function db(path: string): Database | null {
  if (_disabled) return null;
  if (!_db) {
    _db = new Database(path);
    _db.exec("PRAGMA journal_mode=WAL;");
    _db.exec("PRAGMA synchronous=NORMAL;");
  }
  return _db;
}

function ts(): string {
  return new Date().toISOString();
}

/** Disable persistence after an unexpected failure; log the reason once. */
function disable(reason: string, err: unknown): void {
  if (_disabled) return;
  _disabled = true;
  console.error(`[voice:store] disabling DB persistence: ${reason}: ${(err as Error).message}`);
  try {
    _db?.close();
  } catch {
    /* ignore */
  }
  _db = null;
}

function upsertChat(database: Database, chatJid: string, now: string): void {
  database
    .prepare(
      `INSERT INTO chats (jid, name, last_message_time)
       VALUES (?, 'tts', ?)
       ON CONFLICT(jid) DO UPDATE SET last_message_time = MAX(last_message_time, excluded.last_message_time)`,
    )
    .run(chatJid, now);
}

/** Ensure the tts chat row exists. Safe to call repeatedly; never throws. */
export function ensureTtsChat(dbPath: string, chatJid: string): void {
  try {
    const database = db(dbPath);
    if (!database) return;
    database
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time)
         VALUES (?, ?, ?)
         ON CONFLICT(jid) DO NOTHING`,
      )
      .run(chatJid, "tts", ts());
  } catch (err) {
    disable("ensureTtsChat", err);
  }
}

function insertTurn(
  dbPath: string,
  chatJid: string,
  sender: string,
  senderName: string,
  text: string,
  isFromMe: 0 | 1,
  isBot: 0 | 1,
): void {
  try {
    const database = db(dbPath);
    if (!database) return;
    const now = ts();
    database
      .prepare(
        `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`tts-${crypto.randomUUID()}`, chatJid, sender, senderName, text, now, isFromMe, isBot);
    upsertChat(database, chatJid, now);
  } catch (err) {
    disable("insertTurn", err);
  }
}

/** Write a user (voice input) turn. Never throws. */
export function storeUserTurn(dbPath: string, chatJid: string, text: string, userName: string): void {
  insertTurn(dbPath, chatJid, "tts-user", userName, text, 1, 0);
}

/** Write an agent (TTS response) turn. Never throws. */
export function storeAgentTurn(dbPath: string, chatJid: string, text: string, agentName: string): void {
  insertTurn(dbPath, chatJid, "tts-agent", agentName, text, 0, 1);
}

export function closeDb(): void {
  try {
    _db?.close();
  } catch {
    /* ignore */
  }
  _db = null;
}
