/**
 * store/messages.ts
 * Write voice conversation turns directly to the piclaw SQLite DB
 * under the tts:default JID, so they appear in the message store.
 *
 * Uses bun:sqlite (built-in, no extra dep).
 * Opens in WAL mode to coexist safely with the running piclaw process.
 */

import { Database } from "bun:sqlite";

let _db: Database | null = null;

function db(path: string): Database {
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

/** Ensure the tts:default chat exists in the chats table. */
export function ensureTtsChat(dbPath: string, chatJid: string): void {
  db(dbPath)
    .prepare(
      `INSERT INTO chats (jid, name, last_message_time)
       VALUES (?, ?, ?)
       ON CONFLICT(jid) DO NOTHING`,
    )
    .run(chatJid, "tts", ts());
}

/** Write a user (voice input) message to the tts:default JID. */
export function storeUserTurn(
  dbPath: string,
  chatJid: string,
  text: string,
  userName: string,
): void {
  const now = ts();
  const id   = `tts-${crypto.randomUUID()}`;
  db(dbPath)
    .prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES (?, ?, 'tts-user', ?, ?, ?, 1, 0)`,
    )
    .run(id, chatJid, userName, text, now);

  db(dbPath)
    .prepare(
      `INSERT INTO chats (jid, name, last_message_time)
       VALUES (?, 'tts', ?)
       ON CONFLICT(jid) DO UPDATE SET last_message_time = MAX(last_message_time, excluded.last_message_time)`,
    )
    .run(chatJid, now);
}

/** Write an agent (TTS response) message to the tts:default JID. */
export function storeAgentTurn(
  dbPath: string,
  chatJid: string,
  text: string,
  agentName: string,
): void {
  const now = ts();
  const id   = `tts-${crypto.randomUUID()}`;
  db(dbPath)
    .prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES (?, ?, 'tts-agent', ?, ?, ?, 0, 1)`,
    )
    .run(id, chatJid, agentName, text, now);

  db(dbPath)
    .prepare(
      `INSERT INTO chats (jid, name, last_message_time)
       VALUES (?, 'tts', ?)
       ON CONFLICT(jid) DO UPDATE SET last_message_time = MAX(last_message_time, excluded.last_message_time)`,
    )
    .run(chatJid, now);
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
