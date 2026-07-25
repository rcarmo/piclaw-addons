import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

const ADDON_ID = "session-dashboard";
const API_ACTION = "sessions";
const DEFAULT_LIMIT = 9;
const MAX_LIMIT = 12;
const DEFAULT_MESSAGES_DB = "/workspace/.piclaw/store/messages.db";

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

function getMessagesDbPath(): string {
  return process.env.PICLAW_SESSION_DASHBOARD_DB?.trim() || process.env.PICLAW_MESSAGES_DB?.trim() || DEFAULT_MESSAGES_DB;
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

export function queryRecentSessions(options: { dbPath?: string; limit?: unknown } = {}): RecentSessionCard[] {
  const dbPath = options.dbPath || getMessagesDbPath();
  if (!dbPath || !existsSync(dbPath)) return [];
  const limit = clampLimit(options.limit);
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
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
  } finally {
    db.close();
  }
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

const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
if (typeof registerAddonConfigApi === "function") {
  registerAddonConfigApi(ADDON_ID, API_ACTION, {
    get: async (payload, req) => ({
      ok: true,
      sessions: queryRecentSessions({ limit: readLimit(payload, req) }),
      generated_at: new Date().toISOString(),
    }),
  }, import.meta.dir);
}

export default function sessionDashboardAddon(_pi: ExtensionAPI): void {
  // Browser UI is provided by web/index.ts. The backend work is the read-only
  // direct add-on API registered at module load time above.
}
