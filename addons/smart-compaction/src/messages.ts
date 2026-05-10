/**
 * Extracted smart-compaction helper module.
 *
 * Keep this module focused; the public extension facade remains
 * ../smart-compaction.ts.
 */

import type { Message } from "@earendil-works/pi-ai";
import { RECENT_CONTEXT_BUDGET_CHARS, TOOL_RESULT_MAX_CHARS, USER_PREVIEW_MAX_CHARS } from "./config.js";

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as any[])
    .filter((b) => b?.type === "text" && typeof b?.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Synthetic message detection
// ---------------------------------------------------------------------------

/**
 * Prefixes used by pi upstream's convertToLlm to wrap compaction/branch
 * summaries as user-role messages. We must skip these in every function
 * that looks for real user turns.
 */
const SYNTHETIC_USER_PREFIXES = [
  "The conversation history before this point was compacted into the following summary:",
  "The following is a summary of a branch that this conversation came back from:",
];

/** True when a user-role LLM message is actually a synthetic summary wrapper. */
export function isSyntheticUserMessage(msg: Message): boolean {
  if (msg.role !== "user") return false;
  const text = extractText(msg.content);
  return SYNTHETIC_USER_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** True when an LLM user-role message came from a real human user turn. */
export function isRealUserMessage(msg: Message, idx: number, humanUserIndexes?: Set<number>): boolean {
  if (msg.role !== "user") return false;
  if (isSyntheticUserMessage(msg)) return false;
  const text = extractText(msg.content).trim();
  if (!text || text.startsWith("/")) return false;
  return humanUserIndexes ? humanUserIndexes.has(idx) : true;
}

export type SourceMessage = {
  role: string;
  content?: unknown;
  timestamp?: number;
  excludeFromContext?: boolean;
};

function convertToLlm(sourceMessages: SourceMessage[]): Message[] {
  const out: Message[] = [];
  for (const source of sourceMessages) {
    if (source.excludeFromContext) continue;
    if (source.role === "user" || source.role === "assistant" || source.role === "toolResult") {
      out.push(source as Message);
      continue;
    }

    const text = extractText(source.content).trim();
    if (!text) continue;
    out.push({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: typeof source.timestamp === "number" ? source.timestamp : Date.now(),
    } as Message);
  }
  return out;
}

export function isRealUserSourceMessage(msg: SourceMessage): boolean {
  if (msg.role !== "user") return false;
  const text = extractText(msg.content).trim();
  return !!text && !text.startsWith("/");
}

export function convertMessagesWithMetadata(sourceMessages: SourceMessage[]): {
  llmMessages: Message[];
  humanUserIndexes: Set<number>;
} {
  const llmMessages: Message[] = [];
  const humanUserIndexes = new Set<number>();

  for (const source of sourceMessages) {
    const converted = convertToLlm([source as any]);
    if (converted.length === 0) continue;
    const start = llmMessages.length;
    llmMessages.push(...converted);
    if (isRealUserSourceMessage(source)) {
      for (let i = 0; i < converted.length; i++) {
        humanUserIndexes.add(start + i);
      }
    }
  }

  return { llmMessages, humanUserIndexes };
}

export function buildPreview(text: string, maxChars = USER_PREVIEW_MAX_CHARS): string {
  return text.length > maxChars ? text.slice(0, maxChars) + "..." : text;
}

/** Serialize one LLM message to a compact readable line. */
export function serializeMessage(msg: Message, idx: number, humanUserIndexes?: Set<number>): string {
  if (msg.role === "user") {
    if (isSyntheticUserMessage(msg)) {
      // Don't dump the full compaction/branch summary into excerpts.
      // A brief marker is enough — the previous summary is already in the prompt.
      return `[${idx}|CompactionSummary]: (previous compaction summary — see Previous Summary section)`;
    }
    const text = extractText(msg.content);
    if (!text) return "";
    return humanUserIndexes?.has(idx)
      ? `[${idx}|User]: ${text}`
      : `[${idx}|Context]: ${text}`;
  }
  if (msg.role === "assistant") {
    const parts: string[] = [];
    for (const block of msg.content as any[]) {
      if (block.type === "text") parts.push(block.text);
      else if (block.type === "toolCall") {
        const args = block.arguments ?? {};
        const summary = args.path ?? args.command ?? JSON.stringify(args);
        const trunc =
          typeof summary === "string" && summary.length > 120
            ? summary.slice(0, 117) + "..."
            : summary;
        parts.push(`→ ${block.name}(${trunc})`);
      }
    }
    return parts.length ? `[${idx}|Assistant]: ${parts.join(" | ")}` : "";
  }
  if (msg.role === "toolResult") {
    const text = extractText(msg.content);
    if (!text) return "";
    const trunc =
      text.length > TOOL_RESULT_MAX_CHARS
        ? text.slice(0, TOOL_RESULT_MAX_CHARS) +
          `\n… (${text.length - TOOL_RESULT_MAX_CHARS} chars truncated)`
        : text;
    return `[${idx}|ToolResult:${(msg as any).toolName ?? "?"}]: ${trunc}`;
  }
  return "";
}

/**
 * Compress a tool call + result pair into a single compact outcome line.
 * Keeps tool name and key arg, plus a brief outcome summary.
 */
export function serializeToolCompact(assistantMsg: Message, resultMsg: Message | null, idx: number): string {
  const calls: string[] = [];
  for (const block of (assistantMsg.content as any[])) {
    if (block.type === "toolCall") {
      const args = block.arguments ?? {};
      const keyArg = args.path ?? args.command ?? args.pattern ?? args.query ?? null;
      const argStr = typeof keyArg === "string"
        ? (keyArg.length > 80 ? keyArg.slice(0, 77) + "..." : keyArg)
        : "";
      calls.push(`${block.name}(${argStr})`);
    }
    if (block.type === "text" && block.text?.trim()) {
      const t = block.text.trim();
      calls.push(t.length > 150 ? t.slice(0, 147) + "..." : t);
    }
  }
  if (calls.length === 0) return "";

  let outcome = "";
  if (resultMsg) {
    const text = extractText(resultMsg.content).trim();
    if (text) {
      // Extract just the first meaningful line or error indicator
      const firstLine = text.split("\n").find(l => l.trim().length > 0) || "";
      outcome = firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;
    }
  }

  return outcome
    ? `[${idx}|Tool]: ${calls.join("; ")} → ${outcome}`
    : `[${idx}|Tool]: ${calls.join("; ")}`;
}

/**
 * Walk backwards from the end of the message array, capturing user intent
 * with full fidelity while aggressively compressing tool call/result pairs.
 *
 * Returns a set of message indices to include, plus pre-rendered compact
 * versions for tool pairs (overrides the normal serializeMessage output).
 */
export function selectRecentContextBackwards(
  messages: Message[],
  humanUserIndexes?: Set<number>,
): { included: Set<number>; compactOverrides: Map<number, string> } {
  const included = new Set<number>();
  const compactOverrides = new Map<number, string>();
  let budget = RECENT_CONTEXT_BUDGET_CHARS;

  let i = messages.length - 1;
  while (i >= 0 && budget > 0) {
    const msg = messages[i];

    if (msg.role === "user") {
      if (isSyntheticUserMessage(msg)) {
        // Compaction/branch summaries are synthetic — skip, don't eat budget
        i--;
        continue;
      }
      // Keep user-role context, but only real human turns are labeled as User.
      const line = serializeMessage(msg, i, humanUserIndexes);
      included.add(i);
      budget -= line.length;
      i--;
      continue;
    }

    if (msg.role === "assistant") {
      const hasToolCalls = Array.isArray(msg.content) &&
        (msg.content as any[]).some((b: any) => b.type === "toolCall");
      const hasText = Array.isArray(msg.content) &&
        (msg.content as any[]).some((b: any) => b.type === "text" && b.text?.trim());

      if (hasToolCalls) {
        // Find the corresponding tool result ahead
        const resultIdx = i + 1 < messages.length && messages[i + 1].role === "toolResult" ? i + 1 : null;
        const compact = serializeToolCompact(msg, resultIdx !== null ? messages[resultIdx] : null, i);
        if (compact) {
          included.add(i);
          compactOverrides.set(i, compact);
          if (resultIdx !== null) {
            included.add(resultIdx); // mark result as consumed
            compactOverrides.set(resultIdx, ""); // skip separate rendering
          }
          budget -= compact.length;
        }
        i--;
        continue;
      }

      if (hasText) {
        // Assistant explanatory text — keep full
        const line = serializeMessage(msg, i, humanUserIndexes);
        included.add(i);
        budget -= line.length;
        i--;
        continue;
      }
    }

    if (msg.role === "toolResult") {
      // Orphaned tool result not yet consumed by assistant handler above.
      // Skip — it will be captured when the backwards walk reaches the
      // assistant message that issued the call.
      i--;
      continue;
    }

    i--;
  }

  return { included, compactOverrides };
}

// ---------------------------------------------------------------------------
// Fragment selection
// ---------------------------------------------------------------------------
