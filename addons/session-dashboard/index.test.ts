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
  expect(source).toContain("const NARROW_LAYOUT_MAX_WIDTH = 759;");
  expect(source).toContain("const MEDIUM_LAYOUT_MAX_WIDTH = 1079;");
  expect(source).toContain("const RESIZE_DEBOUNCE_MS = 150;");
  expect(source).toContain("const DASHBOARD_REFRESH_INTERVAL_MS = 15000;");
  expect(source).toContain("const FOOTER_CLOCK_INTERVAL_MS = 1000;");
  expect(source).toContain("const LIVE_REFRESH_DEBOUNCE_MS = 1000;");
  expect(source).toContain("const PREVIEW_REFRESH_INTERVAL_MS = 3000;");
  expect(source).toContain("previewByJid: new Map()");
  expect(source).toContain("refreshSessionPreviews");
  expect(source).toContain("/agent/status?chat_jid=");
  expect(source).not.toContain("session-dashboard-toggle-label");
  expect(source).not.toContain("session-dashboard-header");
  expect(source).not.toContain("session-dashboard-title");
  expect(source).not.toContain("session-dashboard-subtitle");
  expect(source).not.toContain("session-dashboard-close");
  expect(source).not.toContain("Active sessions</div>");
  expect(source).toContain("session-dashboard-footer-status");
  expect(source).toContain("scheduleFooterClock");
  expect(source).toContain("renderFooter");
  expect(source).toContain("slots • ${activeCount} active • ${state.currentChatJid}");
  expect(source).toContain('window.addEventListener("resize", handleWindowResize)');
  expect(source).toContain('window.removeEventListener("resize", handleWindowResize)');
  expect(source).toContain('grid-template-columns: repeat(var(--session-dashboard-columns, 4), minmax(0, 1fr))');
  expect(source).not.toContain("repeat(auto-fit");
  expect(source).not.toContain("STORAGE_LIMIT");
  expect(source).not.toContain("/agent/models");
  expect(source).not.toContain("/agent/model");
  expect(source).not.toContain("getModels");
  expect(source).toContain("history.pushState(null, \"\", url)");
  expect(source).toContain('new NavigationEvent("popstate"');
  expect(source).not.toContain("window.location.href = url.toString()");
  expect(source).toContain("--session-dashboard-panel-height");
  expect(source).toContain("--session-dashboard-active-fill");
  expect(source).toContain("flex-direction: column;");
  expect(source).toContain(".session-dashboard-toggle svg { width: 12px; height: 12px; flex-shrink: 0; order: 2;");
  expect(source).toContain("order: 1;");
  expect(source).toContain("width: var(--session-dashboard-active-fill");
  expect(source).toContain("var(--bg-primary");
  expect(source).toContain("var(--bg-secondary");
  expect(source).toContain("var(--border-color");
  expect(source).toContain("var(--radius-md");
  expect(source).toContain("ResizeObserver");
  expect(source).toContain('event.key === "Escape"');
  expect(source).toContain('event.key === "`" || event.key === "~"');
  expect(source).toContain('document.addEventListener("keydown", handleKeydown, true)');
  expect(source).toContain('document.removeEventListener("keydown", handleKeydown, true)');
  expect(source).toContain("event.stopImmediatePropagation?.()");
  expect(source).toContain("isEditableTarget");
  expect(source).toContain(".compose-box");
  expect(source).toContain("event.composedPath?.()");
  expect(source).not.toContain("backdrop-filter");
  expect(source).not.toContain("box-shadow: 0 20px");
  expect(source).not.toContain("border-radius: 16px");
});

test("web layout helper always resolves two rows with four to eight slots", () => {
  expect(__sessionDashboardTest.resolveDashboardLayout(320)).toEqual({ columns: 2, rows: 2, limit: 4 });
  expect(__sessionDashboardTest.resolveDashboardLayout(759)).toEqual({ columns: 2, rows: 2, limit: 4 });
  expect(__sessionDashboardTest.resolveDashboardLayout(760)).toEqual({ columns: 3, rows: 2, limit: 6 });
  expect(__sessionDashboardTest.resolveDashboardLayout(1079)).toEqual({ columns: 3, rows: 2, limit: 6 });
  expect(__sessionDashboardTest.resolveDashboardLayout(1080)).toEqual({ columns: 4, rows: 2, limit: 8 });
  expect(__sessionDashboardTest.resolveDashboardLayout(1920)).toEqual({ columns: 4, rows: 2, limit: 8 });
  expect(__sessionDashboardTest.resolveDashboardLayout(undefined)).toEqual({ columns: 4, rows: 2, limit: 8 });
});

test("web session tiles switch in-app and preserve modified-click new tabs", () => {
  const calls: any[] = [];
  class FakePopStateEvent {
    type: string;
    state: unknown;
    constructor(type: string, options: { state?: unknown } = {}) {
      this.type = type;
      this.state = options.state;
    }
  }
  const runtimeWindow = {
    location: { href: "https://example.test/?chat_jid=web%3Adefault&pane_popout=1&pane_path=notes.md" },
    history: { pushState: (...args: any[]) => calls.push(["push", ...args]) },
    dispatchEvent: (event: any) => { calls.push(["event", event.type]); return true; },
    open: (...args: any[]) => calls.push(["open", ...args]),
    PopStateEvent: FakePopStateEvent,
  };

  expect(__sessionDashboardTest.navigateToSession("web:addons", {}, runtimeWindow)).toBe("in-app");
  expect(calls[0][0]).toBe("push");
  expect(calls[0][3]).toBe("https://example.test/?chat_jid=web%3Aaddons");
  expect(calls[1]).toEqual(["event", "popstate"]);

  calls.length = 0;
  expect(__sessionDashboardTest.navigateToSession("web:auditor", { ctrlKey: true }, runtimeWindow)).toBe("new-tab");
  expect(calls).toEqual([["open", "https://example.test/?chat_jid=web%3Aauditor", "_blank", "noopener"]]);
});

test("web relative-time footer age changes without a network refresh", () => {
  const updatedAt = "2026-07-26T10:00:00.000Z";
  expect(__sessionDashboardTest.formatRelativeTime(updatedAt, Date.parse("2026-07-26T10:00:00.500Z"))).toBe("just now");
  expect(__sessionDashboardTest.formatRelativeTime(updatedAt, Date.parse("2026-07-26T10:00:07.000Z"))).toBe("7s ago");
  expect(__sessionDashboardTest.formatRelativeTime(updatedAt, Date.parse("2026-07-26T10:02:00.000Z"))).toBe("2m ago");
});

test("web tab meter fill is proportional to visible active sessions", () => {
  expect(__sessionDashboardTest.activeFillPercent(0, 8)).toBe(0);
  expect(__sessionDashboardTest.activeFillPercent(2, 8)).toBe(25);
  expect(__sessionDashboardTest.activeFillPercent(8, 8)).toBe(100);
  expect(__sessionDashboardTest.activeFillPercent(12, 8)).toBe(100);
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
    expect(__sessionDashboardTest.isEditableTarget(new FakeElement(".timeline-quick-actions"))).toBe(true);
    expect(__sessionDashboardTest.isEditableTarget(new FakeElement(".timeline-quick-actions-input"))).toBe(true);
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

test("web preview helpers prefer agent output, then show active tool invocations", () => {
  expect(__sessionDashboardTest.normalizePreview("thinking", { text: "**Planning** `next`", totalLines: 1 })).toEqual({
    kind: "thinking",
    label: "thinking",
    text: "Planning next",
    totalLines: 1,
  });
  expect(__sessionDashboardTest.resolveStatusPreview({
    status: "active",
    thought: { text: "thinking", totalLines: 1 },
    draft: { text: "draft text", totalLines: 1 },
    data: { type: "tool_status", title: "Searching files", tool_name: "grep", status: "Streaming output..." },
  })).toMatchObject({ kind: "draft", text: "draft text" });
  expect(__sessionDashboardTest.resolveStatusPreview({
    status: "active",
    thought: { text: "thinking", totalLines: 1 },
    data: { type: "tool_call", title: "Searching files", tool_name: "grep" },
  })).toMatchObject({ kind: "thinking", text: "thinking" });
  expect(__sessionDashboardTest.resolveStatusPreview({
    status: "active",
    data: { type: "tool_call", title: "Searching files", tool_name: "grep" },
  })).toEqual({ kind: "tool", label: "tool", text: "Searching files", totalLines: 1 });
  expect(__sessionDashboardTest.resolveStatusPreview({
    status: "active",
    data: { type: "tool_status", title: "Searching files", tool_name: "grep", status: "Streaming output..." },
  })).toMatchObject({ kind: "tool", text: "Searching files — Streaming output..." });
  expect(__sessionDashboardTest.resolveStatusPreview({
    status: "active",
    data: { type: "tool_status", toolName: "bash", toolStatus: "Working...", toolArgs: { command: "echo hi" } },
  })).toMatchObject({ kind: "tool", text: "bash: echo hi" });
  expect(__sessionDashboardTest.resolveStatusPreview({
    status: "active",
    data: { type: "tool_call", tool_name: "read", tool_args: JSON.stringify({ arguments: { path: "/workspace/foo_bar.ts" } }) },
  })).toMatchObject({ kind: "tool", text: "read: /workspace/foo_bar.ts" });
  expect(__sessionDashboardTest.resolveStatusPreview({
    status: "active",
    data: { type: "tool_call", tool_name: "find", tool_args: { path: "~/.ssh/config", query: "**/*.ts" } },
  })).toMatchObject({ kind: "tool", text: "find: ~/.ssh/config" });
  expect(__sessionDashboardTest.resolveStatusPreview({
    status: "active",
    data: { type: "tool_call", tool_name: "bash", tool_args: { command: "x".repeat(160) } },
  })).toMatchObject({ kind: "tool", text: `bash: ${"x".repeat(119)}…` });
  expect(__sessionDashboardTest.resolveStatusPreview({
    status: "active",
    data: { type: "tool_status", title: "Searching files", tool_name: "grep", status: "Done" },
  })).toBeNull();
  expect(__sessionDashboardTest.resolveStatusPreview({
    status: "active",
    data: { type: "tool_status", title: "Searching files", tool_name: "grep", status: "Failed" },
  })).toBeNull();
  expect(__sessionDashboardTest.resolveStatusPreview({ status: "active", data: { type: "thinking", title: "Thinking..." } })).toBeNull();
  expect(__sessionDashboardTest.resolveStatusPreview({ status: "active", data: { type: "tool_call" } })).toBeNull();
  expect(__sessionDashboardTest.resolveStatusPreview({ status: "idle", data: { type: "tool_call", title: "Hidden" } })).toBeNull();

  const left = new Map([["web:addons", { kind: "draft", text: "same", totalLines: 1 }]]);
  const right = new Map([["web:addons", { kind: "draft", text: "same", totalLines: 1 }]]);
  const changed = new Map([["web:addons", { kind: "tool", text: "same", totalLines: 1 }]]);
  expect(__sessionDashboardTest.previewMapsEqual(left, right)).toBe(true);
  expect(__sessionDashboardTest.previewMapsEqual(left, changed)).toBe(false);
});
