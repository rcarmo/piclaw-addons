/**
 * Extracted smart-compaction helper module.
 *
 * Keep this module focused; the public extension facade remains
 * ../smart-compaction.ts.
 */

import { SYSTEM_PROMPT_OVERHEAD_TOKENS } from "./config.js";


/** Hard cap on generated summary tokens per compaction LLM call. */
const MAX_COMPACTION_OUTPUT_TOKENS = 8_192;

// ---------------------------------------------------------------------------
// Live context usage estimates
// ---------------------------------------------------------------------------

export type SmartCompactionUiContext = {
  ui: {
    setStatus?: (key: string, text: string | undefined) => void;
  };
  model?: { contextWindow?: number; contextLength?: number } | null;
};

export function getModelContextWindow(model: unknown): number | null {
  const anyModel = model as { contextWindow?: number; contextLength?: number } | null | undefined;
  const raw = typeof anyModel?.contextWindow === "number"
    ? anyModel.contextWindow
    : typeof anyModel?.contextLength === "number"
      ? anyModel.contextLength
      : null;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
}

export function getContextWindowEstimate(ctx: SmartCompactionUiContext): number | null {
  return getModelContextWindow(ctx.model ?? null);
}

export function estimateTokensFromChars(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateCompactionPromptTokens(promptText: string): number {
  return estimateTokensFromChars(promptText) + SYSTEM_PROMPT_OVERHEAD_TOKENS;
}

export function publishContextEstimate(
  ctx: SmartCompactionUiContext,
  tokens: number | null,
  phase: string,
): void {
  if (typeof ctx.ui.setStatus !== "function") return;
  const contextWindow = getContextWindowEstimate(ctx);
  if (!contextWindow) return;
  const normalizedTokens = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0
    ? Math.round(tokens)
    : null;
  const percent = normalizedTokens == null ? null : (normalizedTokens / contextWindow) * 100;
  ctx.ui.setStatus("context_usage", JSON.stringify({
    tokens: normalizedTokens,
    contextWindow,
    percent,
    estimated: true,
    source: "smart_compaction",
    phase,
  }));
}
