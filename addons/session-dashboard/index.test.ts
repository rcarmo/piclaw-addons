import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

import { agentNameFromChatJid, extractReadableText, queryRecentSessions, truncateSummary } from "./index.ts";
import { __sessionDashboardTest } from "./web/index.ts";

let cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createMessagesDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-dashboard-"));
  cleanupPaths.push(dir);
  const dbPath = join(dir, "messages.db");
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      content_blocks TEXT,
      link_previews TEXT,
      thread_id TEXT,
      is_terminal_agent_reply INTEGER DEFAULT 0,
      is_steering_message INTEGER DEFAULT 0,
      screen_hint TEXT,
      annotations TEXT,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE TABLE chat_branches (
      branch_id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL UNIQUE,
      root_chat_jid TEXT NOT NULL,
      parent_branch_id TEXT,
      agent_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
  `);
  const insertBranch = db.query(`INSERT INTO chat_branches (branch_id, chat_jid, root_chat_jid, agent_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  insertBranch.run("b-addons", "web:addons", "web:addons", "addons", "2026-07-25T09:00:00.000Z", "2026-07-25T09:00:00.000Z");
  insertBranch.run("b-auditor", "web:default-14", "web:default-14", "auditor", "2026-07-25T09:00:00.000Z", "2026-07-25T09:00:00.000Z");
  insertBranch.run("b-old", "web:old", "web:old", "old", "2026-07-25T09:00:00.000Z", "2026-07-25T09:00:00.000Z");
  const insertMessage = db.query(`INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, content_blocks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertMessage.run("1", "web:old", "assistant", "Smith", "old output", "2026-07-25T08:00:00.000Z", 0, 1, null);
  insertMessage.run("1", "web:default-14", "assistant", "Smith", "Auditor completed review", "2026-07-25T10:00:00.000Z", 0, 1, null);
  insertMessage.run("1", "web:addons", "assistant", "Smith", "older assistant text", "2026-07-25T10:30:00.000Z", 0, 1, null);
  insertMessage.run("2", "web:addons", "assistant", "Smith", "", "2026-07-25T10:45:00.000Z", 0, 1, JSON.stringify([{ type: "TextBlock", text: "Block-only assistant summary" }]));
  insertMessage.run("3", "web:addons", "user", "Rui", "continue", "2026-07-25T11:00:00.000Z", 1, 0, null);
  db.close();
  return dbPath;
}

test("extractReadableText handles markdown and adaptive-card-like blocks", () => {
  expect(extractReadableText("# Title\n\nSee [docs](https://example.test) and `code`.")).toBe("Title\n\nSee docs and code.");
  expect(extractReadableText("", JSON.stringify([{ type: "TextBlock", text: "Card summary" }]))).toBe("Card summary");
});

test("queryRecentSessions returns bounded recent sessions with branch names and block-only summaries", () => {
  const dbPath = createMessagesDb();
  const sessions = queryRecentSessions({ dbPath, limit: 2 });

  expect(sessions.map((session) => session.chat_jid)).toEqual(["web:addons", "web:default-14"]);
  expect(sessions[0]).toMatchObject({ agent_name: "addons", summary: "Block-only assistant summary", message_count: 3 });
  expect(sessions[1]).toMatchObject({ agent_name: "auditor", summary: "Auditor completed review", message_count: 1 });
});

test("queryRecentSessions falls back to a safe agent name when no branch exists", () => {
  const dbPath = createMessagesDb();
  const db = new Database(dbPath);
  db.query(`INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    "1", "web:ad-hoc session", "assistant", "hello", "2026-07-25T12:00:00.000Z", 0, 1,
  );
  db.close();

  const [first] = queryRecentSessions({ dbPath, limit: 1 });
  expect(first.agent_name).toBe("ad-hoc-session");
  expect(agentNameFromChatJid(first.chat_jid)).toBe("ad-hoc-session");
});

test("truncateSummary caps long text with an ellipsis", () => {
  expect(truncateSummary("abcdef", 4)).toBe("abc…");
});

test("web defaults to eight visible sessions and follows sidebar surface variables", () => {
  const source = readFileSync(join(import.meta.dir, "web", "index.ts"), "utf8");

  expect(source).toContain("const DEFAULT_LIMIT = 8;");
  expect(source).not.toContain("session-dashboard-toggle-label");
  expect(source).toContain("--session-dashboard-panel-height");
  expect(source).toContain("var(--bg-primary");
  expect(source).toContain("var(--bg-secondary");
  expect(source).toContain("var(--border-color");
  expect(source).toContain("var(--radius-md");
  expect(source).toContain("ResizeObserver");
  expect(source).toContain('event.key === "Escape"');
  expect(source).toContain('event.key === "`" || event.key === "~"');
  expect(source).toContain("isEditableTarget");
  expect(source).toContain(".compose-box");
  expect(source).toContain("event.composedPath?.()");
  expect(source).not.toContain("backdrop-filter");
  expect(source).not.toContain("box-shadow: 0 20px");
  expect(source).not.toContain("border-radius: 16px");
});

test("web shortcut guard ignores compose and editor targets", () => {
  const previousElement = globalThis.Element;
  class FakeElement {
    selector: string;
    isContentEditable = false;
    constructor(selector: string, isContentEditable = false) {
      this.selector = selector;
      this.isContentEditable = isContentEditable;
    }
    closest(selector: string) {
      return selector.includes(this.selector) ? this : null;
    }
  }
  globalThis.Element = FakeElement as any;
  try {
    expect(__sessionDashboardTest.isEditableTarget(new FakeElement("textarea"))).toBe(true);
    expect(__sessionDashboardTest.isEditableTarget(new FakeElement(".compose-box"))).toBe(true);
    expect(__sessionDashboardTest.isEditableTarget(new FakeElement(".compose-model-popup"))).toBe(true);
    expect(__sessionDashboardTest.isEditableTarget(new FakeElement(".cm-editor"))).toBe(true);
    expect(__sessionDashboardTest.isEditableTarget(new FakeElement("div"), [new FakeElement("span"), new FakeElement(".compose-box")])).toBe(true);
    expect(__sessionDashboardTest.isEditableTarget(new FakeElement("div", true))).toBe(true);
    expect(__sessionDashboardTest.isEditableTarget(new FakeElement("div"))).toBe(false);
  } finally {
    globalThis.Element = previousElement;
  }
});

test("web merge helper keeps active sessions visible and orders streaming sessions first", () => {
  const merged = __sessionDashboardTest.mergeSessions([
    { chat_jid: "web:addons", agent_name: "addons", last_active_at: "2026-07-25T10:00:00.000Z", summary: "work", message_count: 1 },
  ], [
    { chat_jid: "web:auditor", agent_name: "auditor", activity_status: "streaming", is_active: true, model: "github-copilot/gpt-5.6-sol" },
  ], 9);

  expect(merged.map((session: any) => session.chat_jid)).toEqual(["web:auditor", "web:addons"]);
  expect(__sessionDashboardTest.formatContext({ percent: 21.4 })).toBe("21% context");
});
