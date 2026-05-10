/**
 * Extracted smart-compaction helper module.
 *
 * Keep this module focused; the public extension facade remains
 * ../smart-compaction.ts.
 */

import type { FileOperations } from "./types.js";
import type { Message } from "@earendil-works/pi-ai";
import {
  HEAD_USER_TURNS,
  MAX_PROMPT_CHARS,
  TOPIC_SHIFT_CONTEXT_AFTER,
  TOPIC_SHIFT_CONTEXT_BEFORE,
} from "./config.js";
import { compressFilePaths, fileListsFromOps } from "./files.js";
import { buildPreview, extractText, isRealUserMessage, selectRecentContextBackwards, serializeMessage } from "./messages.js";

function detectSessionType(
  messages: Message[],
  humanUserIndexes?: Set<number>,
): "implementation" | "exploration" | "discussion" | "debugging" {
  let hasWrite = false;
  let hasEdit = false;
  let hasRead = false;
  let hasBash = false;
  let errorMentions = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const block of msg.content as any[]) {
        if (block.type !== "toolCall") continue;
        const name: string = block.name;
        if (name === "write") hasWrite = true;
        else if (name === "edit") hasEdit = true;
        else if (name === "read") hasRead = true;
        else if (name === "bash" || name === "exec_batch") hasBash = true;
      }
    } else if (isRealUserMessage(msg, i, humanUserIndexes)) {
      const text = extractText(msg.content).toLowerCase();
      if (
        /\b(error|bug|broken|doesn't work|still wrong|fix|issue)\b/.test(
          text,
        )
      ) {
        errorMentions++;
      }
    }
  }

  if (errorMentions >= 2) return "debugging";
  if (hasWrite || hasEdit) return "implementation";
  if (hasRead || hasBash) return "exploration";
  return "discussion";
}

/** Indices of user messages that look like complaints. */
function findUserComplaints(messages: Message[], humanUserIndexes?: Set<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!isRealUserMessage(messages[i], i, humanUserIndexes)) continue;
    const text = extractText(messages[i].content).toLowerCase();
    if (
      /\b(doesn't work|still broken|still wrong|not working|bug|issue|error|failed|broken|fix)\b/.test(
        text,
      )
    ) {
      out.push(i);
    }
  }
  return out;
}

/** First non-slash-command, non-synthetic user message. */
function findFirstUserRequest(
  messages: Message[],
  humanUserIndexes?: Set<number>,
): { index: number; text: string } | null {
  for (let i = 0; i < messages.length; i++) {
    if (!isRealUserMessage(messages[i], i, humanUserIndexes)) continue;
    const text = extractText(messages[i].content).trim();
    return { index: i, text };
  }
  return null;
}

/** Latest non-slash-command, non-synthetic user message. */
function findLatestUserRequest(
  messages: Message[],
  humanUserIndexes?: Set<number>,
): { index: number; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isRealUserMessage(messages[i], i, humanUserIndexes)) continue;
    const text = extractText(messages[i].content).trim();
    return { index: i, text };
  }
  return null;
}

/** Collect the last N non-slash-command, non-synthetic user turns (newest first). */
function findRecentUserTurns(
  messages: Message[],
  maxTurns = 5,
  humanUserIndexes?: Set<number>,
): { index: number; text: string }[] {
  const turns: { index: number; text: string }[] = [];
  for (let i = messages.length - 1; i >= 0 && turns.length < maxTurns; i--) {
    if (!isRealUserMessage(messages[i], i, humanUserIndexes)) continue;
    const text = extractText(messages[i].content).trim();
    turns.push({ index: i, text });
  }
  return turns;
}

// A1 requirement: pre-prompt compaction must stop biasing the next turn toward
// an older topic when the user has clearly pivoted. We keep this heuristic local
// to piclaw rather than changing upstream compaction because:
//   1. the stale-topic failure is product-specific and evidence-driven here,
//   2. we already own the `session_before_compact` override point, and
//   3. we want deterministic guardrails before the summary ever reaches the next run.
//
// The goal is not perfect topic modeling. It is a conservative detector for the
// common failure mode: the summary says "continue X" even though the newest user
// instruction has switched to Y. We therefore combine:
//   - strong explicit pivot cues ("new topic", "ignore that", "unrelated", ...) that
//     fire independently because they are unambiguous intent signals, and
//   - weak cues ("instead", "switch", "back to", ...) that are common in normal
//     coding conversation and only count as evidence when paired with low lexical
//     overlap between adjacent user turns — this avoids false positives like
//     "use a Map instead of an array" or "add a switch statement".
//
// If this detector fires, newer context gets promoted to "active" and older
// context is demoted to "historical/background" unless recent excerpts reaffirm it.

/** Strong cues: unambiguous topic-shift intent — fire independently. */
const STRONG_PIVOT_CUE_REGEX = /\b(new topic|different (?:topic|issue|problem)|ignore (?:that|this|previous|above|the earlier)|unrelated)\b/i;

/**
 * Weak cues: common in normal coding talk — only count when also supported by
 * low lexical overlap between adjacent user turns.
 */
const WEAK_PIVOT_CUE_REGEX = /\b(switch(?:ing)?(?:\s+back)?(?:\s+to)|instead\b|separately|moving on|back to|let'?s focus on|now for|another thing)\b/i;

const TOPIC_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from", "get", "go",
  "help", "i", "if", "in", "into", "is", "it", "its", "let", "lets", "me", "my", "need", "now",
  "of", "on", "or", "our", "please", "set", "so", "that", "the", "their", "then", "these", "this",
  "to", "up", "use", "using", "we", "with", "work", "you",
]);

interface UserTurn {
  index: number;
  text: string;
  tokens: Set<string>;
}

export interface TopicShiftSignal {
  current: UserTurn;
  previous: UserTurn;
  reasons: string[];
  overlap: number;
}

function tokenizeTopicText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\-\s]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !TOPIC_STOP_WORDS.has(token)),
  );
}

function findUserTurns(messages: Message[], humanUserIndexes?: Set<number>): UserTurn[] {
  const turns: UserTurn[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!isRealUserMessage(messages[i], i, humanUserIndexes)) continue;
    const text = extractText(messages[i].content).trim();
    if (!text || text.startsWith("/")) continue;
    turns.push({ index: i, text, tokens: tokenizeTopicText(text) });
  }
  return turns;
}

function computeTokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export function detectRecentTopicShift(messages: Message[], humanUserIndexes?: Set<number>): TopicShiftSignal | null {
  const userTurns = findUserTurns(messages, humanUserIndexes);
  for (let i = userTurns.length - 1; i >= 1; i--) {
    const current = userTurns[i];
    const previous = userTurns[i - 1];
    const reasons: string[] = [];

    // Strong cues fire independently — they are unambiguous intent.
    const strongMatch = current.text.match(STRONG_PIVOT_CUE_REGEX);
    if (strongMatch?.[0]) {
      reasons.push(`strong pivot cue: "${strongMatch[0]}"`);
    }

    // Compute lexical overlap (needed by both weak-cue and standalone-overlap checks).
    const overlap = computeTokenOverlap(current.tokens, previous.tokens);
    const bothSubstantial = current.tokens.size >= 4 && previous.tokens.size >= 4;

    // Weak cues only count when paired with very low lexical overlap (<= 0.05).
    // Normal coding turns on the same task can have Jaccard as low as 0.06
    // (e.g. "Refactor the auth middleware..." → "Use a Map instead of an array
    // for the token cache..."). We use 0.05 for weak cues to avoid those.
    if (!strongMatch) {
      const weakMatch = current.text.match(WEAK_PIVOT_CUE_REGEX);
      if (weakMatch?.[0] && bothSubstantial && overlap <= 0.05) {
        reasons.push(`weak pivot cue: "${weakMatch[0]}" + low lexical overlap (${overlap.toFixed(2)})`);
      }
    }

    // Standalone low overlap (no cue at all) fires only at an even stricter
    // threshold: truly disjoint vocabulary (Jaccard ~0) is a strong signal on
    // its own, but natural task-continuation variation can easily hit 0.06.
    if (reasons.length === 0 && bothSubstantial && overlap === 0) {
      reasons.push(`zero lexical overlap between substantial turns`);
    }

    if (reasons.length > 0) {
      return { current, previous, reasons, overlap };
    }
  }
  return null;
}

/** Indices of assistant messages with substantial explanatory text. */
function findKeyDecisionMessages(
  messages: Message[],
  exclude: Set<number>,
): number[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (exclude.has(i)) continue;
    if (messages[i].role !== "assistant") continue;
    const textBlocks = (messages[i].content as any[]).filter(
      (b: any) => b.type === "text",
    );
    const totalText = textBlocks.map((b: any) => b.text as string).join("")
      .length;
    if (totalText > 300 && textBlocks.length > 0) {
      indices.push(i);
    }
  }
  // Sample at most 5, evenly distributed
  if (indices.length > 5) {
    const step = Math.floor(indices.length / 5);
    return indices.filter((_, i) => i % step === 0).slice(0, 5);
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are a conversation summarizer creating a structured context checkpoint that another LLM will use to continue the work.

IMPORTANT RULES:
1. Session Type Detection: If you only see "read" tool calls → this is EXPLORATION, not implementation. Only claim files were modified if write/edit tool calls succeeded.
2. Done vs In-Progress: If user reported issues after a change ("doesn't work", "still broken"), mark it as In Progress, NOT Done.
3. Exact Names: Use EXACT variable/function/parameter names from the code.
4. File Lists: Only list files that were actually written/edited successfully. Don't list files that were only read.
5. No-op Filtering: Don't count "Applied: 0" or "No changes applied" as modifications.
6. Topic Pivots: If the prompt identifies a recent topic shift, treat the newest topic as the active lane. Older summary content becomes historical/background unless reaffirmed in recent excerpts.
7. Active vs Background: Put stale or superseded work under Historical / Background Context instead of keeping it as Goal or In Progress.

Use this EXACT format:

## Goal
[What the user is trying to accomplish overall]

## Current Active Topic
- [Newest active thread to continue right now, or "(none)"]

## Historical / Background Context
- [Earlier threads that still matter, or "(none)"]

## Constraints & Preferences
- [Constraints/preferences mentioned by user, or "(none)"]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What remains]

## Critical Context
- [Important state/context needed to continue]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

interface SelectivePromptInput {
  tokensBefore: number;
  previousSummary?: string;
  fileOps: FileOperations;
  /** Compact summary of the kept (surviving) messages. */
  keptMessagesSummary?: string;
  /** Compact excerpt of the dropped prefix of a split current turn, if any. */
  turnPrefixSummary?: string;
}

export function buildSelectivePrompt(
  allMessages: Message[],
  input: SelectivePromptInput,
  customInstructions?: string,
  topicShift?: TopicShiftSignal | null,
  humanUserIndexes?: Set<number>,
): string {
  const total = allMessages.length;
  const sessionType = detectSessionType(allMessages, humanUserIndexes);
  const firstRequest = findFirstUserRequest(allMessages, humanUserIndexes);
  const latestRequest = findLatestUserRequest(allMessages, humanUserIndexes);
  const recentUserTurns = findRecentUserTurns(allMessages, 5, humanUserIndexes);
  // topicShift is pre-computed by the caller to avoid a redundant full scan.
  const shift = topicShift ?? null;
  const complaints = findUserComplaints(allMessages, humanUserIndexes);
  const { readFiles, modifiedFiles } = fileListsFromOps(input.fileOps);

  // A1 requirement: always preserve enough context to distinguish the newest
  // active topic from older background material.
  //
  // Strategy: walk BACKWARDS from the end with a char budget, compressing
  // tool call/result pairs into compact outcome lines. This captures far more
  // user turns (intent) than a fixed tail window that wastes budget on verbose
  // tool output. Then pin head, complaints, and topic-shift boundaries.
  const { included: recentIncluded, compactOverrides } = selectRecentContextBackwards(allMessages, humanUserIndexes);
  const included = new Set<number>(recentIncluded);

  // 1. Head — first few user turns for goal context
  const headEnd = Math.min(HEAD_USER_TURNS * 3, total);
  for (let i = 0; i < headEnd; i++) included.add(i);

  // 2. User complaints + surrounding context
  for (const idx of complaints) {
    for (
      let j = Math.max(0, idx - 1);
      j <= Math.min(total - 1, idx + 3);
      j++
    ) {
      included.add(j);
    }
  }

  // 3. Topic-shift boundary — pin turns on both sides of the pivot
  if (shift) {
    for (
      let j = Math.max(0, shift.previous.index - TOPIC_SHIFT_CONTEXT_BEFORE);
      j <= Math.min(total - 1, shift.current.index + TOPIC_SHIFT_CONTEXT_AFTER);
      j++
    ) {
      included.add(j);
    }
  }

  // 4. Key decision messages from the middle
  const decisions = findKeyDecisionMessages(allMessages, included);
  for (const idx of decisions) {
    included.add(idx);
    for (let j = idx - 1; j >= Math.max(0, idx - 2); j--) {
      included.add(j);
      if (isRealUserMessage(allMessages[j], j, humanUserIndexes)) break;
    }
  }

  const sec: string[] = [];

  sec.push(`## Session Metadata`);
  sec.push(`- Total messages: ${total}`);
  sec.push(`- Session type: ${sessionType}`);
  sec.push(`- Tokens before compaction: ${input.tokensBefore}`);
  if (firstRequest) {
    sec.push(`- First user request: "${buildPreview(firstRequest.text)}"`);
  }
  if (latestRequest) {
    sec.push(`- Latest user request: message ${latestRequest.index} → "${buildPreview(latestRequest.text)}"`);
  }
  if (complaints.length > 0) {
    sec.push(`- User complaints at message indices: ${complaints.join(", ")}`);
  }

  // A1 requirement: the prompt must tell the compaction model which topic is
  // active *before* it sees the previous summary. Otherwise the older summary
  // can dominate the merge and resurrect stale work as if it were current.
  sec.push(`\n## Detected Active Topic (from latest messages)`);
  if (recentUserTurns.length > 0) {
    sec.push(`Recent user instructions (newest first):`);
    for (const turn of recentUserTurns) {
      sec.push(`- [msg ${turn.index}]: "${buildPreview(turn.text)}"`);
    }
    if (latestRequest) {
      sec.push(`- Treat message ${latestRequest.index} as the current active instruction.`);
    }
  } else if (latestRequest) {
    sec.push(`- Treat message ${latestRequest.index} as the newest active user instruction: "${buildPreview(latestRequest.text)}"`);
  } else {
    sec.push(`- (none)`);
  }

  // Show what the user is working on in the KEPT messages (the ones that
  // survive compaction and will follow the summary in context). This is
  // critical: messagesToSummarize only contains what's being discarded,
  // so without this section the LLM has no visibility into the most recent work.
  if (input.keptMessagesSummary) {
    sec.push(`\n## Kept Messages (survive compaction — these represent the CURRENT work)`);
    sec.push(`The following excerpts are in the kept window and will remain in context after compaction. They represent what the user is CURRENTLY working on now, including surviving user turns, assistant/tool progress, and other retained context:`);
    sec.push(input.keptMessagesSummary);
    sec.push(`\nIMPORTANT: The summary you produce must reflect this current work as the active topic, not older topics from the messages being discarded.`);
  }

  if (input.turnPrefixSummary) {
    sec.push(`\n## Split Turn Prefix (discarded prefix of the CURRENT turn)`);
    sec.push(`The compacted window cut through an in-progress turn. The following excerpt is the dropped prefix of that current turn and is needed to understand the kept suffix:`);
    sec.push(input.turnPrefixSummary);
  }

  sec.push(`\n## Historical / Background Context Handling`);
  if (shift) {
    sec.push(`- Recent topic shift detected between user messages ${shift.previous.index} → ${shift.current.index}.`);
    sec.push(`- Previous topic preview: "${buildPreview(shift.previous.text)}"`);
    sec.push(`- New active topic preview: "${buildPreview(shift.current.text)}"`);
    sec.push(`- Shift signals: ${shift.reasons.join("; ")}.`);
    sec.push(`- Treat earlier summary content as background unless it is reaffirmed after message ${shift.current.index}.`);
  } else {
    sec.push(`- No explicit topic shift cue detected. Determine the active topic from the Detected Active Topic and Kept Messages sections above.`);
    sec.push(`- If the kept messages show different work than the previous summary's active topic, update accordingly.`);
  }

  sec.push(`\n## Files Modified (verified from tool results)`);
  if (modifiedFiles.length > 0) {
    sec.push(compressFilePaths(modifiedFiles));
  } else {
    sec.push(`- (none)`);
  }

  sec.push(`\n## Files Read (not modified)`);
  if (readFiles.length > 0) {
    sec.push(compressFilePaths(readFiles));
  } else {
    sec.push(`- (none)`);
  }

  if (input.previousSummary) {
    sec.push(`\n## Previous Summary (merge new information into this)`);
    sec.push(`(Note: the following is the PREVIOUS compaction summary. Its "Current Active Topic" may be outdated — use the Detected Active Topic section above to determine the actual active topic.)`);
    sec.push(input.previousSummary);
  }

  if (customInstructions?.trim()) {
    sec.push(`\n## User Compaction Note`);
    sec.push(`The user passed this instruction to /compact. Use it to guide focus, but don't treat it as the session's main goal.`);
    sec.push(`"${customInstructions.trim()}"`);
  }

  sec.push(`\n## Conversation Excerpts`);
  sec.push(
    `(Selected fragments from ${total} messages \u2014 backwards walk with compressed tool calls, head, complaints${
      shift ? ", topic-shift boundary" : ""
    }, and key decisions)\n`,
  );

  const sorted = [...included].sort((a, b) => a - b);
  let lastIdx = -1;
  let chars = 0;

  for (const idx of sorted) {
    if (chars > MAX_PROMPT_CHARS) {
      sec.push(`\n\u2026 (prompt limit reached, ${sorted.length - sorted.indexOf(idx)} more selected messages omitted)`);
      break;
    }
    if (lastIdx >= 0 && idx > lastIdx + 1) {
      sec.push(`\n--- [${idx - lastIdx - 1} messages omitted] ---\n`);
    }
    // Use compact override if available (compressed tool pairs)
    const override = compactOverrides.get(idx);
    const line = override !== undefined ? override : serializeMessage(allMessages[idx], idx, humanUserIndexes);
    if (line) {
      sec.push(line);
      chars += line.length;
    }
    lastIdx = idx;
  }

  const instruction = shift
    ? `A recent topic shift was detected. Update the summary so the newest topic becomes the Current Active Topic. Move older work that is not reaffirmed after message ${shift.current.index} into Historical / Background Context instead of keeping it as the Goal or current in-progress work.`
    : input.previousSummary
      ? `Update the previous summary with the new information from these conversation excerpts. Preserve existing information and add new progress, decisions, and context.`
      : `Summarize these conversation excerpts into a structured context checkpoint. Focus on what matters for continuing the work.`;

  return sec.join("\n") + `\n\n---\n\n${instruction}`;
}

// ---------------------------------------------------------------------------
// Progressive iterative compaction
