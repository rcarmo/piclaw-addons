import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

export interface MessageRow {
  rowid: number;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_bot_message?: number;
  content_blocks?: string | null;
  thread_id?: number | null;
}
export interface ReviewMessage {
  rowid: number;
  speaker: "assistant" | "user";
  content: string;
  truncated: boolean;
}
export interface Exchange {
  rowid: number;
  chat_jid: string;
  timestamp: string;
  target: ReviewMessage;
  context: ReviewMessage[];
}
export interface ReviewPacket {
  window: { start: string; end: string; chat_jid: string };
  coverage: {
    eligible: number;
    selected: number;
    omitted: number;
    excluded: Record<string, number>;
    mode: "all" | "ranked_sample" | "sample_only";
    ranking: string;
    sampled: number;
    estimated_tokens: number;
    budget_tokens: number;
  };
  exchanges: Exchange[];
}
export const isAssistant = (row: MessageRow): boolean =>
  row.is_bot_message === 1 ||
  row.sender === "agent" ||
  row.sender === "web-agent";

/** Only provenance is filtered. Short human messages, including 'continue', remain eligible. */
export function exclusion(row: MessageRow): string | null {
  if (isAssistant(row)) return "assistant";
  if (!row.content?.trim()) return "empty";
  let blocks: any[] = [];
  try {
    const value = JSON.parse(row.content_blocks || "[]");
    if (Array.isArray(value)) blocks = value;
  } catch {
    /* retain uncertain origin */
  }
  if (
    blocks.some(
      (b) =>
        b &&
        ([
          "restart_handoff",
          "self_continuation",
          "peer_message",
          "scheduled_task",
        ].includes(b.type) ||
          (b.type === "control_intent" &&
            b.intent === "protected_recovery_continuation")),
    )
  )
    return "structured_automation";
  if (/^From: [^\n]+\nReply-To: [^\n]+\nTo: [^\n]+\n/.test(row.content))
    return "legacy_peer_envelope";
  if (/^\s*🎯\s*(?:Continue goal|Goal updated)\s*:/u.test(row.content))
    return "legacy_goal_envelope";
  return null;
}

/** Defence in depth, not a guarantee that arbitrary prose is free of secrets. */
export function boundedText(
  text: string,
  max = 1200,
): { content: string; truncated: boolean } {
  const cleaned = text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[private key omitted]",
    )
    .replace(/```[\s\S]*?(?:```|$)/g, "[code/log block omitted]")
    .replace(
      /^.*(?:\b(?:password|passwd|secret|api[ _-]?key|access[ _-]?token|authorization)\b\s*[:=]|\bBearer\s+\S+|\b(?:ghp_|github_pat_|sk-|AIza)[A-Za-z0-9_-]{12,}).*$/gim,
      "[credential-bearing line omitted]",
    )
    .replace(/(?:https?:\/\/|data:)\S+/g, "[URL omitted]")
    .replace(/\b[A-Za-z0-9+/_=-]{60,}\b/g, "[opaque value omitted]")
    .replace(
      /^.{400,}$/gm,
      (line) => line.slice(0, 400) + " [long line omitted]",
    );
  return {
    content: cleaned.slice(0, max),
    truncated: cleaned.length > max || cleaned !== text,
  };
}
function view(row: MessageRow, max = 900): ReviewMessage {
  return {
    rowid: row.rowid,
    speaker: isAssistant(row) ? "assistant" : "user",
    ...boundedText(row.content, max),
  };
}
export function buildExchange(
  target: MessageRow,
  neighbours: MessageRow[],
  references: MessageRow[] = [],
): Exchange {
  const usable = (row: MessageRow) =>
    row.chat_jid === target.chat_jid && (isAssistant(row) || !exclusion(row));
  const before = neighbours
    .filter((r) => r.rowid < target.rowid && usable(r))
    .slice(-6);
  const after = neighbours
    .filter((r) => r.rowid > target.rowid && usable(r))
    .slice(0, 2);
  const referenced = references.filter(
    (r) => r.rowid < target.rowid && usable(r),
  );
  const unique = [
    ...new Map(
      [...referenced, ...before, ...after].map((r) => [r.rowid, r]),
    ).values(),
  ].sort((a, b) => a.rowid - b.rowid);
  return {
    rowid: target.rowid,
    chat_jid: target.chat_jid,
    timestamp: target.timestamp,
    target: view(target, 1600),
    context: unique.map((r) => view(r)),
  };
}

export function readExchanges(
  dbPath: string,
  window: ReviewPacket["window"],
): { exchanges: Exchange[]; excluded: Record<string, number> } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const columns =
      "rowid, chat_jid, sender, sender_name, content, timestamp, is_bot_message, content_blocks, thread_id";
    const targets = db
      .query<MessageRow, [string, string, string, string]>(
        `SELECT ${columns} FROM messages WHERE (?='*' OR chat_jid=?) AND timestamp>=? AND timestamp<? AND content_erased=0 ORDER BY rowid`,
      )
      .all(window.chat_jid, window.chat_jid, window.start, window.end);
    const preceding = db.query<MessageRow, [string, number]>(
      `SELECT ${columns} FROM messages WHERE chat_jid=? AND rowid<? AND content_erased=0 ORDER BY rowid DESC LIMIT 60`,
    );
    const following = db.query<MessageRow, [string, number, string]>(
      `SELECT ${columns} FROM messages WHERE chat_jid=? AND rowid>? AND timestamp<? AND content_erased=0 ORDER BY rowid LIMIT 20`,
    );
    const referenced = db.query<MessageRow, [string, number]>(
      `SELECT ${columns} FROM messages WHERE chat_jid=? AND rowid=? AND content_erased=0`,
    );
    const excluded: Record<string, number> = {};
    const exchanges: Exchange[] = [];
    for (const row of targets) {
      const reason = exclusion(row);
      if (reason) {
        excluded[reason] = (excluded[reason] || 0) + 1;
        continue;
      }
      const ids = [...row.content.matchAll(/message:(\d+)/g)]
        .slice(0, 3)
        .map((m) => Number(m[1]));
      if (row.thread_id) ids.push(row.thread_id);
      const refs = ids
        .map((id) => referenced.get(row.chat_jid, id))
        .filter((r): r is MessageRow => !!r);
      const before = preceding.all(row.chat_jid, row.rowid).reverse();
      exchanges.push(
        buildExchange(
          row,
          [...before, ...following.all(row.chat_jid, row.rowid, window.end)],
          refs,
        ),
      );
    }
    return { exchanges, excluded };
  } finally {
    db.close();
  }
}

/** Share repeated excerpts once; targets remain separate so their larger text limit is preserved. */
export function compactPacket(packet: ReviewPacket) {
  const context = new Map<number, ReviewMessage & { chat_jid: string }>();
  for (const exchange of packet.exchanges)
    for (const message of exchange.context)
      context.set(message.rowid, { ...message, chat_jid: exchange.chat_jid });
  return {
    window: packet.window,
    coverage: packet.coverage,
    exchanges: packet.exchanges.map(({ context: messages, ...exchange }) => ({
      ...exchange,
      context_ids: messages.map((m) => m.rowid),
    })),
    context_messages: [...context.values()].sort((a, b) => a.rowid - b.rowid),
  };
}

export function selectReview(
  exchanges: Exchange[],
  window: ReviewPacket["window"],
  budgetTokens = 24000,
  excluded: Record<string, number> = {},
  rank?: (e: Exchange) => number,
): ReviewPacket {
  if (
    !Number.isSafeInteger(budgetTokens) ||
    budgetTokens < 512 ||
    budgetTokens > 100000
  )
    throw new Error("Review budget must be 512–100000 estimated tokens");
  const packet: ReviewPacket = {
    window,
    coverage: {
      eligible: exchanges.length,
      selected: exchanges.length,
      omitted: 0,
      excluded,
      mode: "all",
      ranking: "not needed",
      sampled: 0,
      estimated_tokens: 0,
      budget_tokens: budgetTokens,
    },
    exchanges: [...exchanges],
  };
  // UTF-8 bytes / 3 is a conservative sizing heuristic, not a tokenizer or billing cap.
  const bytes = () => Buffer.byteLength(JSON.stringify(compactPacket(packet)));
  const limit = budgetTokens * 3;
  const finish = () => {
    packet.exchanges.sort((a, b) => a.rowid - b.rowid);
    packet.coverage.selected = packet.exchanges.length;
    packet.coverage.omitted = exchanges.length - packet.exchanges.length;
    packet.coverage.estimated_tokens = Math.ceil((bytes() + 16) / 3);
    return packet;
  };
  if (bytes() + 32 <= limit) return finish();
  packet.coverage.mode = rank ? "ranked_sample" : "sample_only";
  packet.coverage.ranking = rank
    ? "frozen Bayes ordering; scores are not calibrated probabilities"
    : "no valid ranker; repeatable sample only";
  packet.exchanges = [];
  const scores = new Map(exchanges.map((e) => [e.rowid, rank ? rank(e) : 0]));
  const ordered = [...exchanges].sort(
    (a, b) => scores.get(b.rowid)! - scores.get(a.rowid)! || a.rowid - b.rowid,
  );
  const append = (e: Exchange, cap: number) => {
    packet.exchanges.push(e);
    if (bytes() + 32 > cap) {
      packet.exchanges.pop();
      return false;
    }
    return true;
  };
  // Reserve 20% for a repeatable sample; the remainder is filled by rank.
  if (rank) for (const e of ordered) append(e, limit * 0.8);
  const chosen = new Set(packet.exchanges.map((e) => e.rowid));
  const key = (e: Exchange) =>
    createHash("sha256").update(`${window.end}|${e.rowid}`).digest("hex");
  const remainder = exchanges
    .filter((e) => !chosen.has(e.rowid))
    .sort((a, b) => key(a).localeCompare(key(b)));
  for (const e of remainder) if (append(e, limit)) packet.coverage.sampled++;
  return finish();
}
