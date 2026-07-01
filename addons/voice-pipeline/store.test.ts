import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, ensureTtsChat, storeAgentTurn, storeUserTurn } from "./store/messages.ts";

// Compatibility test against the current messages/chats schema (#5). Uses the
// same column shape as runtime/src/db/connection.ts so a future schema change
// that drops one of these columns fails here rather than in production.
const dir = mkdtempSync(join(tmpdir(), "voice-store-"));
const dbPath = join(dir, "messages.db");

// Recreate the columns the add-on writes to.
const seed = new Database(dbPath);
seed.exec(`CREATE TABLE chats (
  jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT
);`);
seed.exec(`CREATE TABLE messages (
  id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT,
  timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER,
  content_blocks TEXT, link_previews TEXT, thread_id TEXT,
  is_terminal_agent_reply INTEGER, is_steering_message INTEGER,
  screen_hint TEXT, annotations TEXT
);`);
seed.close();

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test("store writes user + agent turns without throwing (#5)", () => {
  ensureTtsChat(dbPath, "tts:default");
  storeUserTurn(dbPath, "tts:default", "hello", "🎤 Voice");
  storeAgentTurn(dbPath, "tts:default", "hi back", "Flint");

  const check = new Database(dbPath);
  const msgs = check.query("SELECT sender, content, is_from_me, is_bot_message FROM messages ORDER BY sender").all() as Array<{
    sender: string; content: string; is_from_me: number; is_bot_message: number;
  }>;
  const chats = check.query("SELECT jid FROM chats").all() as Array<{ jid: string }>;
  check.close();

  expect(msgs).toHaveLength(2);
  expect(chats).toHaveLength(1);
  const user = msgs.find((m) => m.sender === "tts-user")!;
  const agent = msgs.find((m) => m.sender === "tts-agent")!;
  expect(user.content).toBe("hello");
  expect(user.is_from_me).toBe(1);
  expect(agent.is_bot_message).toBe(1);
});
