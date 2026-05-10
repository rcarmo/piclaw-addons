/**
 * Extracted smart-compaction helper module.
 *
 * Keep this module focused; the public extension facade remains
 * ../smart-compaction.ts.
 */

import {
  BUDGET_SAFETY_MARGIN,
  MAX_COMPACTION_OUTPUT_TOKENS,
  MAX_KEEP_RECENT_FRACTION,
  MIN_COMPACTION_OUTPUT_TOKENS,
  PROGRESSIVE_FALLBACK_CONTEXT_WINDOW,
  SYSTEM_PROMPT_OVERHEAD_TOKENS,
} from "./config.js";
import { estimateCompactionPromptTokens, estimateTokensFromChars, getModelContextWindow } from "./context.js";


// ---------------------------------------------------------------------------
// Post-compaction verification and keepRecentTokens clamping
// ---------------------------------------------------------------------------

/**
 * Clamp keepRecentTokens to at most MAX_KEEP_RECENT_FRACTION of the effective
 * context window (after subtracting system prompt overhead). Prevents the kept
 * window from consuming so much context that summary + system prompt + tools
 * don't fit.
 */
export function clampKeepRecentTokens(keepRecentTokens: number, contextWindow: number): number {
  const effectiveWindow = Math.max(4_000, contextWindow - SYSTEM_PROMPT_OVERHEAD_TOKENS);
  const maxKeep = Math.floor(effectiveWindow * MAX_KEEP_RECENT_FRACTION);
  return Math.min(keepRecentTokens, maxKeep);
}

/**
 * Estimate whether the post-compaction context will fit in the model's window.
 * Returns the estimated total and whether it overflows.
 */
export function estimatePostCompactionFit(summary: string, keepRecentTokens: number, contextWindow: number): {
  estimatedTotal: number;
  fits: boolean;
  summaryTokens: number;
  overheadTokens: number;
  margin: number;
} {
  const summaryTokens = estimateTokensFromChars(summary);
  const overheadTokens = SYSTEM_PROMPT_OVERHEAD_TOKENS;
  const estimatedTotal = summaryTokens + keepRecentTokens + overheadTokens;
  const margin = contextWindow - estimatedTotal;
  return {
    estimatedTotal,
    fits: margin > 0,
    summaryTokens,
    overheadTokens,
    margin,
  };
}

export function getSafeCompactionMaxTokens(model: unknown, promptText: string, requestedMaxTokens: number): {
  maxTokens: number;
  promptTokens: number;
  availableOutputTokens: number;
  contextWindow: number;
} {
  const contextWindow = getModelContextWindow(model) ?? PROGRESSIVE_FALLBACK_CONTEXT_WINDOW;
  const promptTokens = estimateCompactionPromptTokens(promptText);
  const availableOutputTokens = Math.floor((contextWindow - promptTokens) * BUDGET_SAFETY_MARGIN);
  if (availableOutputTokens < MIN_COMPACTION_OUTPUT_TOKENS) {
    throw new Error(
      `Compaction prompt exceeds safe model budget: prompt+overhead=${promptTokens}t, context=${contextWindow}t, availableOutput=${availableOutputTokens}t`,
    );
  }
  return {
    maxTokens: Math.max(
      MIN_COMPACTION_OUTPUT_TOKENS,
      Math.min(Math.floor(requestedMaxTokens), availableOutputTokens, MAX_COMPACTION_OUTPUT_TOKENS),
    ),
    promptTokens,
    availableOutputTokens,
    contextWindow,
  };
}

export interface ProgressiveCompactionBudget {
  contextWindow: number;
  promptBudgetChars: number;
  chunkBudgetChars: number;
  mergeBudgetChars: number;
  forceProgressive: boolean;
}
