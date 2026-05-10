/**
 * Extracted smart-compaction helper module.
 *
 * Keep this module focused; the public extension facade remains
 * ../smart-compaction.ts.
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import type { FileOperations } from "./types.js";
import {
  BUDGET_SAFETY_MARGIN,
  MAX_PROGRESSIVE_CHUNKS,
  MAX_PROMPT_CHARS,
  MIN_SUMMARY_CHARS,
  PROGRESSIVE_CHUNK_FRACTION,
  PROGRESSIVE_FALLBACK_CONTEXT_WINDOW,
  PROGRESSIVE_INPUT_CONTEXT_FRACTION,
  PROGRESSIVE_TIME_BUDGET_FRACTION,
  SYSTEM_PROMPT_OVERHEAD_TOKENS,
  parseFirstPositiveEnvInt,
} from "./config.js";
import { estimateCompactionPromptTokens, getModelContextWindow } from "./context.js";
import { compressFilePaths, fileListsFromOps } from "./files.js";
import { serializeMessage, serializeToolCompact } from "./messages.js";
import { getSafeCompactionMaxTokens } from "./safety.js";
import { SYSTEM_PROMPT } from "./selective-prompt.js";

export interface ProgressiveCompactionBudget {
  contextWindow: number;
  promptBudgetChars: number;
  chunkBudgetChars: number;
  mergeBudgetChars: number;
  forceProgressive: boolean;
}

export interface ProgressiveCompactionChunk {
  index: number;
  startMessageIndex: number;
  endMessageIndex: number;
  text: string;
  estimatedChars: number;
}

export function getProgressiveCompactionBudget(model: unknown): ProgressiveCompactionBudget {
  const contextWindow = Math.max(8_000, getModelContextWindow(model) ?? PROGRESSIVE_FALLBACK_CONTEXT_WINDOW);
  // Subtract system prompt overhead before computing input budgets.
  // The overhead (AGENTS.md, tools, skills, memory) is invisible to message
  // token estimates but eats real context space.
  const effectiveWindow = Math.max(4_000, contextWindow - SYSTEM_PROMPT_OVERHEAD_TOKENS);
  const envBudget = parseFirstPositiveEnvInt([
    "PI_SMART_COMPACTION_PROGRESSIVE_PROMPT_CHARS",
    "PICLAW_PROGRESSIVE_COMPACTION_PROMPT_CHARS",
  ]);
  const rawPromptBudget = envBudget ?? Math.max(10_000, Math.min(MAX_PROMPT_CHARS, Math.floor(effectiveWindow * 4 * PROGRESSIVE_INPUT_CONTEXT_FRACTION)));
  // Apply safety margin: leave room for estimation inaccuracy
  const promptBudgetChars = Math.floor(rawPromptBudget * BUDGET_SAFETY_MARGIN);
  const chunkBudgetChars = Math.max(6_000, Math.floor(promptBudgetChars * PROGRESSIVE_CHUNK_FRACTION));
  const mergeBudgetChars = Math.max(8_000, promptBudgetChars);
  return {
    contextWindow,
    promptBudgetChars,
    chunkBudgetChars,
    mergeBudgetChars,
    forceProgressive: process.env.PI_SMART_COMPACTION_PROGRESSIVE === "1" || process.env.PICLAW_PROGRESSIVE_COMPACTION === "1",
  };
}

function serializeProgressiveSourceLines(
  messages: Message[],
  humanUserIndexes?: Set<number>,
): Array<{ startMessageIndex: number; endMessageIndex: number; text: string }> {
  const lines: Array<{ startMessageIndex: number; endMessageIndex: number; text: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray((msg as any).content)) {
      const hasToolCalls = ((msg as any).content as any[]).some((b: any) => b?.type === "toolCall");
      if (hasToolCalls) {
        const resultIdx = i + 1 < messages.length && messages[i + 1].role === "toolResult" ? i + 1 : null;
        const compact = serializeToolCompact(msg, resultIdx !== null ? messages[resultIdx] : null, i);
        if (compact) {
          lines.push({
            startMessageIndex: i,
            endMessageIndex: resultIdx ?? i,
            text: compact,
          });
          if (resultIdx !== null) i = resultIdx;
          continue;
        }
      }
    }
    const text = serializeMessage(msg, i, humanUserIndexes);
    if (text) lines.push({ startMessageIndex: i, endMessageIndex: i, text });
  }
  return lines;
}

export function buildProgressiveCompactionChunks(
  messages: Message[],
  budgetChars: number,
  humanUserIndexes?: Set<number>,
): ProgressiveCompactionChunk[] {
  const sourceLines = serializeProgressiveSourceLines(messages, humanUserIndexes);
  const chunks: ProgressiveCompactionChunk[] = [];
  let current: string[] = [];
  let startMessageIndex = sourceLines[0]?.startMessageIndex ?? 0;
  let endMessageIndex = sourceLines[0]?.endMessageIndex ?? 0;
  let chars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.join("\n");
    chunks.push({
      index: chunks.length + 1,
      startMessageIndex,
      endMessageIndex,
      text,
      estimatedChars: text.length,
    });
    current = [];
    chars = 0;
  };

  for (const line of sourceLines) {
    const nextChars = line.text.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && chars + nextChars > budgetChars) {
      flush();
      startMessageIndex = line.startMessageIndex;
    } else if (current.length === 0) {
      startMessageIndex = line.startMessageIndex;
    }
    current.push(line.text);
    chars += nextChars;
    endMessageIndex = line.endMessageIndex;
  }
  flush();
  return chunks;
}

function buildChunkSummaryPrompt(chunk: ProgressiveCompactionChunk, totalChunks: number): string {
  return `You are summarizing one deterministic chunk of a longer conversation for progressive compaction.

Chunk: ${chunk.index}/${totalChunks}
Message index range: ${chunk.startMessageIndex}-${chunk.endMessageIndex}

Preserve facts in this structured intermediate form:

## Chunk Range
- ${chunk.startMessageIndex}-${chunk.endMessageIndex}

## Goals / User Intent
- ...

## Constraints & Preferences
- ...

## Decisions
- ...

## Files / Commands / Tool Outcomes
- ...

## Progress
- Done: ...
- In progress: ...
- Blocked: ...

## Open Questions / Next Steps
- ...

## Key Continuity Facts
- ...

Rules:
- Do not invent completion. If uncertain, say so.
- Preserve exact file paths, commands, function names, issue numbers, PR numbers, errors, and user corrections.
- Keep ordering-sensitive facts tied to the chunk range.

<chunk>
${chunk.text}
</chunk>`;
}

function buildMergePrompt(input: {
  summaries: string[];
  rangeLabel: string;
  final: boolean;
  previousSummary?: string;
  keptMessagesSummary?: string;
  turnPrefixSummary?: string;
  customInstructions?: string;
  fileOps?: FileOperations;
}): string {
  const sections: string[] = [];
  sections.push(input.final
    ? "Merge these ordered intermediate compaction summaries into the final continuity state."
    : "Merge these ordered intermediate compaction summaries into a smaller intermediate summary.");
  sections.push(`Range: ${input.rangeLabel}`);
  sections.push("\nRules:");
  sections.push("- Preserve goals, constraints, decisions, files, commands, open questions, user preferences, and current next steps.");
  sections.push("- Preserve exact paths, issue/PR numbers, commands, function names, and errors.");
  sections.push("- Preserve chronological ordering where it matters; newest active work wins over stale background work.");
  sections.push("- Do not drop user corrections or reported failures.");
  if (input.previousSummary) {
    sections.push("\n## Previous Summary To Update");
    sections.push(input.previousSummary);
  }
  if (input.keptMessagesSummary) {
    sections.push("\n## Kept Messages That Survive Compaction (current work)");
    sections.push(input.keptMessagesSummary);
  }
  if (input.turnPrefixSummary) {
    sections.push("\n## Split Turn Prefix Context");
    sections.push(input.turnPrefixSummary);
  }
  if (input.customInstructions?.trim()) {
    sections.push("\n## User Compaction Note");
    sections.push(input.customInstructions.trim());
  }
  sections.push("\n## Ordered Intermediate Summaries");
  input.summaries.forEach((summary, idx) => {
    sections.push(`\n<summary index="${idx + 1}">\n${summary}\n</summary>`);
  });
  if (input.final) {
    const files = input.fileOps ? fileListsFromOps(input.fileOps) : { readFiles: [], modifiedFiles: [] };
    sections.push("\nOutput this exact final format:");
    sections.push(SYSTEM_PROMPT.replace(/^You are[\s\S]*?Use this EXACT format:\n\n/, ""));
    sections.push("\nFile facts from deterministic tool analysis:");
    sections.push(`Modified files:\n${files.modifiedFiles.length ? compressFilePaths(files.modifiedFiles) : "- (none)"}`);
    sections.push(`Read files:\n${files.readFiles.length ? compressFilePaths(files.readFiles) : "- (none)"}`);
  } else {
    sections.push("\nReturn a concise structured intermediate summary with the same headings as the chunk summaries.");
  }
  return sections.join("\n");
}

async function completeCompactionPrompt(
  model: any,
  auth: { apiKey?: string; headers?: Record<string, string> },
  promptText: string,
  maxTokens: number,
  abortSignal: AbortSignal,
): Promise<string> {
  if (abortSignal.aborted) throw new Error("Compaction cancelled");
  const safeOutput = getSafeCompactionMaxTokens(model, promptText, maxTokens);
  const response = await completeSimple(
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
    },
    (model as any).reasoning
      ? { maxTokens: safeOutput.maxTokens, signal: abortSignal, apiKey: auth.apiKey, headers: auth.headers, reasoning: "high" as const }
      : { maxTokens: safeOutput.maxTokens, signal: abortSignal, apiKey: auth.apiKey, headers: auth.headers },
  );
  if ((response as any).stopReason === "error") {
    throw new Error((response as any).errorMessage || "Progressive compaction LLM error");
  }
  const summary = response.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n")
    .trim();
  if (summary.length < MIN_SUMMARY_CHARS) {
    throw new Error("Progressive compaction summary too short");
  }
  if (abortSignal.aborted) throw new Error("Compaction cancelled");
  return summary;
}

async function mergeProgressiveSummaries(input: {
  summaries: string[];
  model: any;
  auth: { apiKey?: string; headers?: Record<string, string> };
  budget: ProgressiveCompactionBudget;
  maxTokens: number;
  abortSignal: AbortSignal;
  ctx: { ui: { setWorkingMessage?: (msg?: string) => void; notify?: (msg: string, level?: "info" | "warning" | "error") => void } };
  finalPromptExtras: Omit<Parameters<typeof buildMergePrompt>[0], "summaries" | "rangeLabel" | "final">;
  publishEstimate?: (tokens: number, phase: string) => void;
}): Promise<string> {
  let summaries = input.summaries;
  let pass = 1;
  while (summaries.join("\n\n").length > input.budget.mergeBudgetChars && summaries.length > 1) {
    const next: string[] = [];
    let batch: string[] = [];
    let chars = 0;
    for (const summary of summaries) {
      const nextChars = summary.length + 2;
      if (batch.length > 0 && chars + nextChars > input.budget.mergeBudgetChars) {
        input.ctx.ui.setWorkingMessage?.(`Smart compaction: merging pass ${pass}, batch ${next.length + 1}…`);
        const mergePrompt = buildMergePrompt({ summaries: batch, rangeLabel: `merge-pass-${pass}`, final: false });
        input.publishEstimate?.(estimateCompactionPromptTokens(mergePrompt), `merge_pass_${pass}_batch_${next.length + 1}`);
        next.push(await completeCompactionPrompt(
          input.model,
          input.auth,
          mergePrompt,
          input.maxTokens,
          input.abortSignal,
        ));
        batch = [];
        chars = 0;
      }
      batch.push(summary);
      chars += nextChars;
    }
    if (batch.length > 0) {
      input.ctx.ui.setWorkingMessage?.(`Smart compaction: merging pass ${pass}, batch ${next.length + 1}…`);
      const mergePrompt = buildMergePrompt({ summaries: batch, rangeLabel: `merge-pass-${pass}`, final: false });
      input.publishEstimate?.(estimateCompactionPromptTokens(mergePrompt), `merge_pass_${pass}_batch_${next.length + 1}`);
      next.push(await completeCompactionPrompt(
        input.model,
        input.auth,
        mergePrompt,
        input.maxTokens,
        input.abortSignal,
      ));
    }
    input.ctx.ui.notify?.(`Progressive compaction: merge pass ${pass} reduced ${summaries.length} → ${next.length} summaries`, "info");
    summaries = next;
    pass += 1;
  }

  input.ctx.ui.setWorkingMessage?.("Smart compaction: final progressive merge…");
  const finalPrompt = buildMergePrompt({
    summaries,
    rangeLabel: "final",
    final: true,
    ...input.finalPromptExtras,
  });
  input.publishEstimate?.(estimateCompactionPromptTokens(finalPrompt), "merge_final");
  return await completeCompactionPrompt(
    input.model,
    input.auth,
    finalPrompt,
    input.maxTokens,
    input.abortSignal,
  );
}

export async function runProgressiveCompaction(input: {
  llmMessages: Message[];
  humanUserIndexes: Set<number>;
  model: any;
  auth: { apiKey?: string; headers?: Record<string, string> };
  settings: { reserveTokens: number };
  previousSummary?: string;
  keptMessagesSummary?: string;
  turnPrefixSummary?: string;
  customInstructions?: string;
  fileOps: FileOperations;
  budget: ProgressiveCompactionBudget;
  abortSignal: AbortSignal;
  ctx: { ui: { setWorkingMessage?: (msg?: string) => void; notify?: (msg: string, level?: "info" | "warning" | "error") => void } };
  /** Compaction timeout (ms) — used to enforce a time budget so progressive doesn't run over. */
  timeoutMs?: number;
  /** Timestamp when compaction started — paired with timeoutMs for elapsed-time guard. */
  startedAt?: number;
  /** Callback to publish context estimate to the UI meter. */
  publishEstimate?: (tokens: number, phase: string) => void;
}): Promise<string> {
  let allChunks = buildProgressiveCompactionChunks(
    input.llmMessages,
    input.budget.chunkBudgetChars,
    input.humanUserIndexes,
  );

  // Guard: cap chunk count to prevent cost/time explosion. Size the retry from
  // the serialized chunk payloads (not raw message text), otherwise tool-call
  // summaries can be badly undercounted and the cap is only aspirational.
  if (allChunks.length > MAX_PROGRESSIVE_CHUNKS) {
    const originalChunkCount = allChunks.length;
    const totalSerializedChars = allChunks.reduce((total, chunk) => total + chunk.estimatedChars, 0);
    const enlargedBudget = Math.ceil(totalSerializedChars / MAX_PROGRESSIVE_CHUNKS);
    allChunks = buildProgressiveCompactionChunks(
      input.llmMessages,
      Math.max(input.budget.chunkBudgetChars, enlargedBudget),
      input.humanUserIndexes,
    );
    input.ctx.ui.notify?.(
      `Progressive compaction: re-chunked to ${allChunks.length} chunks (capped from ${originalChunkCount}, budget ${Math.round(enlargedBudget / 1000)}k chars/chunk)`,
      "info",
    );
    if (allChunks.length > MAX_PROGRESSIVE_CHUNKS) {
      throw new Error(
        `Progressive compaction would require ${allChunks.length} chunks after re-chunking (max ${MAX_PROGRESSIVE_CHUNKS}); refusing to run an unbounded compaction`,
      );
    }
  }

  const chunks = allChunks;
  const maxTokens = Math.floor(0.8 * input.settings.reserveTokens);
  input.ctx.ui.notify?.(
    `Progressive compaction: ${input.llmMessages.length} messages → ${chunks.length} chunks (budget ${Math.round(input.budget.chunkBudgetChars / 1000)}k chars/chunk)`,
    "info",
  );

  const chunkSummaries: string[] = [];
  for (const chunk of chunks) {
    // Time budget guard: abort if we've consumed most of the timeout
    if (input.timeoutMs && input.startedAt) {
      const elapsed = Date.now() - input.startedAt;
      if (elapsed > input.timeoutMs * PROGRESSIVE_TIME_BUDGET_FRACTION) {
        throw new Error(
          `Progressive compaction time budget exhausted after ${chunkSummaries.length}/${chunks.length} chunks (${Math.round(elapsed / 1000)}s of ${Math.round(input.timeoutMs / 1000)}s); refusing to merge an incomplete summary`,
        );
      }
    }
    input.ctx.ui.setWorkingMessage?.(`Smart compaction: summarizing chunk ${chunk.index}/${chunks.length}…`);
    const chunkPrompt = buildChunkSummaryPrompt(chunk, chunks.length);
    input.publishEstimate?.(estimateCompactionPromptTokens(chunkPrompt), `progressive_chunk_${chunk.index}`);
    chunkSummaries.push(await completeCompactionPrompt(
      input.model,
      input.auth,
      chunkPrompt,
      maxTokens,
      input.abortSignal,
    ));
    input.ctx.ui.notify?.(`Progressive compaction: chunk ${chunk.index}/${chunks.length} summarized`, "info");
  }

  if (chunkSummaries.length === 0) {
    throw new Error("Progressive compaction produced no chunk summaries (time budget exhausted before first chunk)");
  }

  return await mergeProgressiveSummaries({
    summaries: chunkSummaries,
    model: input.model,
    auth: input.auth,
    budget: input.budget,
    maxTokens,
    abortSignal: input.abortSignal,
    ctx: input.ctx,
    publishEstimate: input.publishEstimate,
    finalPromptExtras: {
      previousSummary: input.previousSummary,
      keptMessagesSummary: input.keptMessagesSummary,
      turnPrefixSummary: input.turnPrefixSummary,
      customInstructions: input.customInstructions,
      fileOps: input.fileOps,
    },
  });
}

// ---------------------------------------------------------------------------
