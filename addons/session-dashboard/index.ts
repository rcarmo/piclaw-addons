import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Database } from "bun:sqlite";

const ADDON_ID = "session-dashboard";
const API_ACTION = "sessions";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;

export interface RecentSessionCard {
  chat_jid: string;
  agent_name: string;
  root_chat_jid: string | null;
  branch_id: string | null;
  last_active_at: string | null;
  summary: string;
  message_count: number;
  is_archived: boolean;
}

interface RecentSessionRow {
  chat_jid: string;
  agent_name: string | null;
  root_chat_jid: string | null;
  branch_id: string | null;
  archived_at: string | null;
  last_active_at: string | null;
  message_count: number | null;
  last_bot_content: string | null;
  last_bot_blocks: string | null;
  last_content: string | null;
  last_blocks: string | null;
}

type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: {
    get?: (payload: unknown, req: Request) => unknown | Promise<unknown>;
    set?: (payload: unknown, req: Request) => unknown | Promise<unknown>;
  },
  extensionPath?: string,
) => "created" | "updated";

function clampLimit(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(numeric)));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function stripMarkdownNoise(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^```[\s\S]*?```$/g, "")
    .replace(/```+/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .trim();
}

function collectBlockText(value: unknown, output: string[], depth = 0): void {
  if (depth > 5 || value == null || output.length > 40) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) output.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBlockText(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  for (const key of ["text", "title", "fallback", "altText", "summary", "content"]) {
    const current = obj[key];
    if (typeof current === "string" && current.trim()) output.push(current.trim());
  }
  for (const key of ["body", "items", "columns", "actions", "facts", "content_blocks"]) {
    collectBlockText(obj[key], output, depth + 1);
  }
}

export function extractReadableText(content: unknown, contentBlocks?: unknown): string {
  if (typeof content === "string" && content.trim()) return stripMarkdownNoise(content);
  const rawBlocks = typeof contentBlocks === "string" ? parseJson(contentBlocks) : contentBlocks;
  const parts: string[] = [];
  collectBlockText(rawBlocks, parts);
  return stripMarkdownNoise(parts.join("\n"));
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

export function truncateSummary(value: unknown, maxLength = 180): string {
  const normalized = extractReadableText(value).replace(/\s+/g, " ").trim();
  if (!normalized) return "No recent output yet.";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function agentNameFromChatJid(chatJid: string): string {
  const suffix = String(chatJid || "").split(":").pop() || "session";
  return suffix.replace(/^default$/, "default").replace(/[^a-zA-Z0-9._-]+/g, "-") || "session";
}

function mapRow(row: RecentSessionRow): RecentSessionCard {
  const botText = extractReadableText(row.last_bot_content, row.last_bot_blocks);
  const fallbackText = extractReadableText(row.last_content, row.last_blocks);
  return {
    chat_jid: row.chat_jid,
    agent_name: row.agent_name || agentNameFromChatJid(row.chat_jid),
    root_chat_jid: row.root_chat_jid || null,
    branch_id: row.branch_id || null,
    last_active_at: row.last_active_at || null,
    summary: truncateSummary(botText || fallbackText),
    message_count: Number(row.message_count || 0),
    is_archived: Boolean(row.archived_at),
  };
}

export function queryRecentSessions(options: { root: Database; limit?: unknown }): RecentSessionCard[] {
  const limit = clampLimit(options.limit);
  const db = options.root;
    const rows = db.query(`
      WITH recent AS (
        SELECT chat_jid, max(timestamp) AS last_active_at, count(*) AS message_count
        FROM messages
        WHERE chat_jid LIKE 'web:%'
        GROUP BY chat_jid
        ORDER BY datetime(last_active_at) DESC
        LIMIT $limit
      )
      SELECT
        recent.chat_jid,
        branches.agent_name,
        branches.root_chat_jid,
        branches.branch_id,
        branches.archived_at,
        recent.last_active_at,
        recent.message_count,
        (
          SELECT content FROM messages AS bot
          WHERE bot.chat_jid = recent.chat_jid
            AND (coalesce(trim(bot.content), '') <> '' OR coalesce(trim(bot.content_blocks), '') <> '')
            AND (bot.is_bot_message = 1 OR bot.is_terminal_agent_reply = 1 OR lower(coalesce(bot.sender, '')) IN ('assistant', 'agent'))
          ORDER BY datetime(bot.timestamp) DESC
          LIMIT 1
        ) AS last_bot_content,
        (
          SELECT content_blocks FROM messages AS bot
          WHERE bot.chat_jid = recent.chat_jid
            AND (coalesce(trim(bot.content), '') <> '' OR coalesce(trim(bot.content_blocks), '') <> '')
            AND (bot.is_bot_message = 1 OR bot.is_terminal_agent_reply = 1 OR lower(coalesce(bot.sender, '')) IN ('assistant', 'agent'))
          ORDER BY datetime(bot.timestamp) DESC
          LIMIT 1
        ) AS last_bot_blocks,
        (
          SELECT content FROM messages AS latest
          WHERE latest.chat_jid = recent.chat_jid
            AND (coalesce(trim(latest.content), '') <> '' OR coalesce(trim(latest.content_blocks), '') <> '')
          ORDER BY datetime(latest.timestamp) DESC
          LIMIT 1
        ) AS last_content,
        (
          SELECT content_blocks FROM messages AS latest
          WHERE latest.chat_jid = recent.chat_jid
            AND (coalesce(trim(latest.content), '') <> '' OR coalesce(trim(latest.content_blocks), '') <> '')
          ORDER BY datetime(latest.timestamp) DESC
          LIMIT 1
        ) AS last_blocks
      FROM recent
      LEFT JOIN chat_branches AS branches ON branches.chat_jid = recent.chat_jid
      ORDER BY datetime(recent.last_active_at) DESC
    `).all({ $limit: limit }) as RecentSessionRow[];
    return rows.map(mapRow);
}

function readLimit(payload: unknown, req: Request): number {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  try {
    const url = new URL(req.url, "https://example.test/");
    return clampLimit(url.searchParams.get("limit") || body.limit);
  } catch {
    return clampLimit(body.limit);
  }
}

/** Read-only application projection port. No database path or SQL accepted. */
export interface DashboardScope { ownerId: string; authScope: string }
export interface NativeDashboardSession {
  conversationId: string;
  chatJid: string;
  agentName?: string;
  updatedAt: string | null;
  messageCount: number;
  latestOutput?: string;
  latestBlocks?: string;
  sessionId?: string;
  usage?: unknown | null;
  tasks?: readonly { id: number; status: string }[];
  history?: { rootChatJid?: string; branchId?: string; archivedAt?: string };
}
export interface DashboardReader {
  read(options: DashboardScope & { limit: number }): Promise<readonly NativeDashboardSession[]>;
}
const dashboardBindings = new WeakSet<object>();
export function bindNativeSessionDashboard(options: {
  scope: DashboardScope;
  reader: DashboardReader;
  authorize(req: Request, scope: DashboardScope): boolean;
  isCurrent(): boolean;
  register(addon: string, action: string, handlers: { get(payload: unknown, req: Request): Promise<unknown> }): () => void;
}): () => void {
  const scope = Object.freeze({ ...options.scope });
  if (!scope.ownerId || !scope.authScope) throw new Error("Dashboard scope required");
  if (dashboardBindings.has(options.register)) throw new Error("Dashboard already bound");
  let disposed = false;
  const check = (req: Request) => {
    if (disposed || !options.isCurrent() || !options.authorize(req, scope)) throw new Error("Dashboard owner/auth scope rejected");
  };
  const unregister = options.register(ADDON_ID, API_ACTION, {
    get: async (payload, req) => {
      check(req);
      const limit = readLimit(payload, req);
      const rows = await options.reader.read({ ...scope, limit });
      check(req);
      const sessions = rows.slice(0, limit).map(row => ({
        chat_jid: row.chatJid,
        agent_name: row.agentName || agentNameFromChatJid(row.chatJid),
        root_chat_jid: row.history?.rootChatJid || null,
        branch_id: row.history?.branchId || null,
        last_active_at: row.updatedAt,
        summary: truncateSummary(extractReadableText(row.latestOutput, row.latestBlocks)),
        conversation_id: row.conversationId,
        session_id: row.sessionId ?? null,
        usage: row.usage ?? null,
        tasks: row.tasks ?? null,
        message_count: row.messageCount,
        is_archived: Boolean(row.history?.archivedAt),
      }));
      return { ok: true, sessions, generated_at: new Date().toISOString() };
    },
  });
  dashboardBindings.add(options.register);
  return () => { if (!disposed) { disposed = true; dashboardBindings.delete(options.register); unregister(); } };
}

/** Legacy Root query retained for historical metadata consumers only. */
export function bindSessionDashboardProjection(root: Database, assertCurrent: () => void) {
  return Object.freeze({ get: async (payload: unknown, req: Request) => {
    assertCurrent();
    const sessions = queryRecentSessions({ root, limit: readLimit(payload, req) });
    assertCurrent();
    return { ok: true, sessions, generated_at: new Date().toISOString() };
  } });
}
export default function sessionDashboardAddon(_pi: ExtensionAPI): void {}
