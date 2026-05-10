/**
 * Extracted smart-compaction helper module.
 *
 * Keep this module focused; the public extension facade remains
 * ../smart-compaction.ts.
 */

import type { CompactionResult, FileOperations } from "./types.js";
import type { Message } from "@earendil-works/pi-ai";
import { KEPT_CONTEXT_BUDGET_CHARS, MIN_SUMMARY_CHARS } from "./config.js";
import { compressFilePaths, fileListsFromOps } from "./files.js";
import {
  buildPreview,
  convertMessagesWithMetadata,
  extractText,
  isRealUserMessage,
  isRealUserSourceMessage,
  selectRecentContextBackwards,
  serializeMessage,
  serializeToolCompact,
  type SourceMessage,
} from "./messages.js";
import type { TopicShiftSignal } from "./selective-prompt.js";

// ---------------------------------------------------------------------------

/**
 * Detect compaction windows where an LLM call is unnecessary.
 *
 * Two patterns are detected:
 *
 * 1. **Split-turn continuation** — The compaction window contains zero user
 *    messages (the agent was executing a long tool-call sequence that hit the
 *    token limit mid-turn). The previous summary already describes the goal
 *    and progress; we just append a mechanical file-ops delta.
 *
 * 2. **Minimal content** — Very little user input (<100 chars) and no file
 *    modifications. The previous summary is still valid.
 *
 * A1 caveat: this optimisation is only safe when the tiny user input is *not*
 * actually a topic pivot (for example: "new topic: Azure streaming"). Reusing
 * the previous summary in that situation is exactly how stale-topic bias leaks
 * into the next turn. We therefore disable the minimal-content fast path when
 * the newest user message looks like a pivot.
 *
 * Returns a `{ compaction }` result to short-circuit the LLM path, or
 * `null` to fall through to selective/built-in compaction.
 */
export function tryNoOpCompaction(
  llmMessages: Message[],
  preparation: {
    previousSummary?: string;
    fileOps: FileOperations;
    isSplitTurn?: boolean;
  },
  firstKeptEntryId: string,
  tokensBefore: number,
  topicShift: TopicShiftSignal | null,
  humanUserIndexes: Set<number>,
  currentWorkHints: {
    hasKeptUserContext: boolean;
    hasTurnPrefixHumanUser: boolean;
  },
  ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } },
): { compaction: CompactionResult } | null {
  const { previousSummary, fileOps } = preparation;

  // We can only do no-op if there IS a previous summary to reuse
  if (!previousSummary || previousSummary.length < MIN_SUMMARY_CHARS) {
    return null;
  }

  // Count real user messages (non-slash-command, non-synthetic)
  let userMessageCount = 0;
  let userTotalChars = 0;
  for (let i = 0; i < llmMessages.length; i++) {
    const msg = llmMessages[i];
    if (isRealUserMessage(msg, i, humanUserIndexes)) {
      const text = extractText(msg.content);
      userMessageCount++;
      userTotalChars += text.length;
    }
  }

  const { readFiles, modifiedFiles } = fileListsFromOps(fileOps);
  const hasModifications = modifiedFiles.length > 0;
  // topicShift is pre-computed by the caller.

  // ── Pattern 1: Split-turn continuation ────────────────────────────
  // Zero user messages in the discarded window can still be unsafe if the
  // dropped prefix of the current turn contains a fresh user instruction.
  if (preparation.isSplitTurn && userMessageCount === 0 && !currentWorkHints.hasTurnPrefixHumanUser) {
    const delta = buildMechanicalDelta(llmMessages, modifiedFiles, readFiles);
    const summary = appendDeltaToSummary(previousSummary, delta, fileOps);

    ctx.ui.notify(
      `No-op compaction: split-turn continuation (0 user msgs, ${llmMessages.length} tool msgs) → reused summary + delta`,
      "info",
    );

    return {
      compaction: { summary, firstKeptEntryId, tokensBefore },
    };
  }

  // ── Pattern 2: Minimal content ────────────────────────────────────
  // Tiny user input, no modifications → usually nothing new to capture.
  // But if that tiny input is a pivot cue, we must force the LLM path so the
  // summary can demote the stale topic and promote the new one.
  if (
    userTotalChars < 100 &&
    !hasModifications &&
    !topicShift &&
    !currentWorkHints.hasKeptUserContext &&
    !currentWorkHints.hasTurnPrefixHumanUser
  ) {
    const summary = updateFileLists(previousSummary, fileOps);

    ctx.ui.notify(
      `No-op compaction: minimal content (${userTotalChars} user chars, 0 modifications) → reused summary`,
      "info",
    );

    return {
      compaction: { summary, firstKeptEntryId, tokensBefore },
    };
  }

  return null;
}

/**
 * Build a compact mechanical description of what happened in a split-turn
 * window (tool calls only, no user messages).
 */
function buildMechanicalDelta(
  messages: Message[],
  modifiedFiles: string[],
  readFiles: string[],
): string {
  // Count tool calls by type
  const toolCounts: Record<string, number> = {};
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block.type === "toolCall") {
          const name = block.name as string;
          toolCounts[name] = (toolCounts[name] || 0) + 1;
        }
      }
    }
  }

  const parts: string[] = [];
  parts.push(
    `Continued execution: ${messages.length} messages (split-turn, no new user input)`,
  );

  const toolSummary = Object.entries(toolCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
  if (toolSummary) parts.push(`Tool calls: ${toolSummary}`);

  if (modifiedFiles.length > 0) {
    const shown = modifiedFiles.slice(0, 10);
    parts.push(`Files modified: ${shown.join(", ")}${modifiedFiles.length > 10 ? ` (+${modifiedFiles.length - 10} more)` : ""}`);
  }

  if (readFiles.length > 0) {
    parts.push(`Files read: ${readFiles.length} files`);
  }

  return parts.join("\n");
}

/**
 * Append a mechanical delta to the previous summary, preserving structure.
 * Also updates the file lists at the end.
 */
function appendDeltaToSummary(
  previousSummary: string,
  delta: string,
  fileOps: FileOperations,
): string {
  // Strip old file-list tags from previous summary — we'll re-append fresh ones
  let base = previousSummary
    .replace(/<read-files>[\s\S]*?<\/read-files>/g, "")
    .replace(/<modified-files>[\s\S]*?<\/modified-files>/g, "")
    .trimEnd();

  // Insert delta before Critical Context or at the end
  const criticalIdx = base.lastIndexOf("## Critical Context");
  if (criticalIdx > 0) {
    base =
      base.slice(0, criticalIdx) +
      `\n### Split-Turn Continuation\n${delta}\n\n` +
      base.slice(criticalIdx);
  } else {
    base += `\n\n### Split-Turn Continuation\n${delta}`;
  }

  return appendFileLists(base, fileOps);
}

/**
 * Update file lists in a summary without changing anything else.
 */
function updateFileLists(summary: string, fileOps: FileOperations): string {
  const base = summary
    .replace(/<read-files>[\s\S]*?<\/read-files>/g, "")
    .replace(/<modified-files>[\s\S]*?<\/modified-files>/g, "")
    .trimEnd();

  return appendFileLists(base, fileOps);
}

/**
 * Append deterministic file-list tags to a summary string.
 */
export function appendFileLists(base: string, fileOps: FileOperations): string {
  const { readFiles, modifiedFiles } = fileListsFromOps(fileOps);
  const parts: string[] = [base];

  if (readFiles.length > 0) {
    parts.push(`\n<read-files>\n${compressFilePaths(readFiles)}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    parts.push(
      `\n<modified-files>\n${compressFilePaths(modifiedFiles)}\n</modified-files>`,
    );
  }

  return parts.join("\n");
}

function normalizeSerializedLine(line: string): string {
  return line.replace(/^\[\d+\|([^\]]+)\]:\s*/, "[$1]: ");
}

function compactInlineText(text: string, maxChars = 240): string {
  return buildPreview(text.replace(/\s+/g, " ").trim(), maxChars);
}

function serializeKeptEntryMessage(message: SourceMessage, nextMessage?: SourceMessage): string[] {
  const lines: string[] = [];

  if (message.role === "assistant") {
    const assistantCtx = convertMessagesWithMetadata([message]);
    const assistantLlm = assistantCtx.llmMessages[0];
    const hasToolCalls = Array.isArray((assistantLlm as any)?.content) &&
      ((assistantLlm as any).content as any[]).some((b: any) => b.type === "toolCall");

    if (assistantLlm && hasToolCalls) {
      let resultLlm: Message | null = null;
      if (nextMessage?.role === "toolResult") {
        resultLlm = convertMessagesWithMetadata([nextMessage]).llmMessages[0] ?? null;
      }
      const compact = serializeToolCompact(assistantLlm, resultLlm, 0);
      if (compact) return [normalizeSerializedLine(compact)];
    }
  }

  const ctx = convertMessagesWithMetadata([message]);
  for (let i = 0; i < ctx.llmMessages.length; i++) {
    const line = serializeMessage(ctx.llmMessages[i], i, ctx.humanUserIndexes);
    if (line) lines.push(normalizeSerializedLine(line));
  }

  return lines;
}

/**
 * Extract a compact summary of the kept window (the entries that survive
 * compaction) from the full session entries. This tells the LLM what current
 * work will remain in context after the new summary, including user turns,
 * assistant/tool progress, branch summaries, and extension custom messages.
 */
export function extractKeptMessagesSummary(
  branchEntries: any[],
  firstKeptEntryId: string,
): { summary: string; hasHumanUser: boolean } {
  let foundKept = false;
  const lines: string[] = [];
  let hasHumanUser = false;

  for (let i = 0; i < branchEntries.length; i++) {
    const entry = branchEntries[i];
    if (entry.id === firstKeptEntryId) foundKept = true;
    if (!foundKept) continue;
    if (entry.type === "compaction") continue;

    if (entry.type === "message" && entry.message) {
      const message = entry.message as SourceMessage;
      if (isRealUserSourceMessage(message)) hasHumanUser = true;

      const nextMessage =
        entry.message?.role === "assistant" &&
        branchEntries[i + 1]?.type === "message" &&
        branchEntries[i + 1]?.message?.role === "toolResult"
          ? (branchEntries[i + 1].message as SourceMessage)
          : undefined;

      const serialized = serializeKeptEntryMessage(message, nextMessage);
      if (serialized.length > 0) lines.push(...serialized);
      if (nextMessage) i++;
      continue;
    }

    if (entry.type === "custom_message") {
      const text = extractText(entry.content).trim();
      if (!text) continue;
      lines.push(`[Context:${entry.customType ?? "custom"}]: ${compactInlineText(text, 400)}`);
      continue;
    }

    if (entry.type === "branch_summary") {
      const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
      if (!summary) continue;
      lines.push(`[BranchSummary]: ${compactInlineText(summary, 400)}`);
    }
  }

  if (lines.length === 0) return { summary: "", hasHumanUser };

  const selected: string[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (selected.length > 0 && chars + line.length > KEPT_CONTEXT_BUDGET_CHARS) break;
    selected.push(line);
    chars += line.length;
  }

  selected.reverse();
  return { summary: selected.join("\n"), hasHumanUser };
}

export function buildTurnPrefixSummary(
  turnPrefixMessages: Message[],
  humanUserIndexes: Set<number>,
): string {
  if (turnPrefixMessages.length === 0) return "";

  const { included, compactOverrides } = selectRecentContextBackwards(
    turnPrefixMessages,
    humanUserIndexes,
  );
  const sorted = [...included].sort((a, b) => a - b);
  const lines: string[] = [];
  let chars = 0;

  for (const idx of sorted) {
    const line = compactOverrides.get(idx) ?? serializeMessage(turnPrefixMessages[idx], idx, humanUserIndexes);
    if (!line) continue;
    lines.push(line);
    chars += line.length;
    if (chars >= 4_000) break;
  }

  return lines.join("\n");
}
