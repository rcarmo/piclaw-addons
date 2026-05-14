/**
 * smart-compaction.ts – Selective-fragment compaction extension.
 *
 * Public facade for the smart-compaction extension. Implementation details are
 * split into focused modules under ./smart-compaction/ so budget logic, prompt
 * construction, progressive compaction, no-op handling, message serialization,
 * file-list handling, and UI context-meter publishing can be maintained
 * independently.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";

import { MIN_SUMMARY_CHARS, PROGRESSIVE_FALLBACK_CONTEXT_WINDOW, SELECTIVE_THRESHOLD } from "./src/config.js";
import { estimateCompactionPromptTokens, getContextWindowEstimate, publishContextEstimate } from "./src/context.js";
import { compressFilePaths, fileListsFromOps } from "./src/files.js";
import { convertMessagesWithMetadata, type SourceMessage } from "./src/messages.js";
import { appendFileLists, buildTurnPrefixSummary, extractKeptMessagesSummary, tryNoOpCompaction } from "./src/noop.js";
import { buildProgressiveCompactionChunks, getProgressiveCompactionBudget, runProgressiveCompaction } from "./src/progressive.js";
import { clampKeepRecentTokens, estimatePostCompactionFit, getSafeCompactionMaxTokens } from "./src/safety.js";
import { buildSelectivePrompt, detectRecentTopicShift, SYSTEM_PROMPT } from "./src/selective-prompt.js";
import type { CompactionResult } from "./src/types.js";

export {
  buildProgressiveCompactionChunks,
  clampKeepRecentTokens,
  estimatePostCompactionFit,
  getProgressiveCompactionBudget,
  getSafeCompactionMaxTokens,
};

const log = { debug: (...args: unknown[]) => { if (process.env.PI_SMART_COMPACTION_DEBUG === "1") console.debug("[smart-compaction]", ...args); } };

// ---------------------------------------------------------------------------
// Resilient UI proxy – ctx.ui can throw when the extension context is invalidated
// after a session replacement/reload. UI updates are cosmetic; losing them must
// never abort the compaction itself.
// ---------------------------------------------------------------------------

function resilientUi(ctx: { ui: Record<string, unknown> }): typeof ctx.ui {
  return new Proxy(ctx.ui, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          return (value as Function).apply(target, args);
        } catch (err) {
          if (err instanceof Error && /stale|disposed|invalid/i.test(err.message)) {
            log.debug(`UI call ${String(prop)} suppressed (stale ctx)`);
            return undefined;
          }
          throw err;
        }
      };
    },
  });
}

type ResilientCtx<T> = Omit<T, "ui"> & { ui: T extends { ui: infer U } ? U : never };

function makeResilientCtx<T extends { ui: Record<string, unknown> }>(ctx: T): ResilientCtx<T> {
  return Object.create(ctx, { ui: { get: () => resilientUi(ctx), configurable: true } });
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export function smartCompaction(pi: ExtensionAPI): void {
  const looksLikePiclaw = !!(
    process.env.PICLAW_WORKSPACE ||
    process.env.PICLAW_INTERNAL_SECRET ||
    process.env.PICLAW_WEB_INTERNAL_SECRET
  );

  // This package is for vanilla pi. Piclaw already ships this extension as a
  // built-in, so stay inert there to avoid duplicate session_before_compact
  // handlers. Set PI_SMART_COMPACTION_ALLOW_PICLAW=1 only for deliberate local
  // testing.
  if (looksLikePiclaw && process.env.PI_SMART_COMPACTION_ALLOW_PICLAW !== "1") {
    console.warn(
      "[smart-compaction] Disabled: this standalone add-on is intended for vanilla pi users; Piclaw already includes smart compaction.",
    );
    return;
  }

  pi.on("session_before_compact", async (event, rawCtx) => {
    const ctx = makeResilientCtx(rawCtx as any) as typeof rawCtx;
    const { preparation, signal, customInstructions, branchEntries } = event;
    const {
      messagesToSummarize,
      tokensBefore,
      firstKeptEntryId,
      previousSummary,
      settings,
    } = preparation;

    let finalContextTokens: number | null = null;

    if (messagesToSummarize.length === 0) return;

    ctx.ui.setWorkingIndicator({ frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 90 });
    ctx.ui.setWorkingMessage(`Smart compaction: scanning ${messagesToSummarize.length} messages…`);
    publishContextEstimate(ctx, tokensBefore, "scanning");

    try {
      // Capture the signal reference from the event. The upstream
      // `_compactionAbortController` can be cleared by a concurrent `compact()`
      // call's finally block while our async handler is in flight. By capturing
      // the signal here we can check `.aborted` reliably and return `{ cancel }`
      // instead of falling through — which would crash upstream when it accesses
      // the already-cleared controller.
      const abortSignal = signal;

      // ── Compute topic-shift signal once for all downstream paths ──────
      // Both tryNoOpCompaction (to gate the minimal-content fast path) and
      // buildSelectivePrompt (to annotate the compaction prompt) need this.
      // We preserve source-message provenance so synthetic upstream user-role
      // wrappers (branch/compaction summaries, custom messages, bashExecution)
      // don't get mistaken for real human user turns.
      const { llmMessages, humanUserIndexes } = convertMessagesWithMetadata(
        messagesToSummarize as SourceMessage[],
      );

      // Check abort early — a concurrent compact() may have already cancelled us.
      if (abortSignal.aborted) return { cancel: true };

      const topicShift = detectRecentTopicShift(llmMessages, humanUserIndexes);

      log.debug("Pivot detection result", {
        detected: !!topicShift,
        reasons: topicShift?.reasons ?? [],
        overlap: topicShift?.overlap ?? null,
        messageCount: llmMessages.length,
      });

      // Extract kept-messages context from branchEntries so the LLM knows
      // what the user is currently working on (kept messages survive compaction).
      const keptContext = branchEntries
        ? extractKeptMessagesSummary(branchEntries, firstKeptEntryId)
        : { summary: "", hasHumanUser: false };
      const keptMessagesSummary = keptContext.summary;
      const turnPrefixContext = preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0
        ? convertMessagesWithMetadata(preparation.turnPrefixMessages as SourceMessage[])
        : null;
      const turnPrefixSummary = turnPrefixContext
        ? buildTurnPrefixSummary(
            turnPrefixContext.llmMessages,
            turnPrefixContext.humanUserIndexes,
          )
        : "";

      // ── No-op detection ──────────────────────────────────────────────
      // Skip the LLM call entirely when we can produce a good summary
      // mechanically. This saves ~60-110s and 100-270k input tokens.
      const noOpResult = tryNoOpCompaction(
        llmMessages,
        preparation,
        firstKeptEntryId,
        tokensBefore,
        topicShift,
        humanUserIndexes,
        {
          hasKeptUserContext: keptContext.hasHumanUser,
          hasTurnPrefixHumanUser: !!turnPrefixContext && turnPrefixContext.humanUserIndexes.size > 0,
        },
        ctx,
      );
      if (noOpResult) {
        const contextWindow = getContextWindowEstimate(ctx) || PROGRESSIVE_FALLBACK_CONTEXT_WINDOW;
        const configuredKeepRecent = Math.max(0, Number(settings.keepRecentTokens) || 0);
        const safeKeepRecent = clampKeepRecentTokens(configuredKeepRecent, contextWindow);
        const postFit = estimatePostCompactionFit(noOpResult.compaction.summary, configuredKeepRecent, contextWindow);
        if (!postFit.fits || configuredKeepRecent > safeKeepRecent) {
          log.debug(
            `No-op compaction: post-compaction estimate ${postFit.estimatedTotal} tokens is unsafe for ${contextWindow} context (configured kept ${configuredKeepRecent}t, safe kept ${safeKeepRecent}t, margin ${postFit.margin}t). Falling through to LLM compaction.`,
            "warning",
          );
          publishContextEstimate(ctx, postFit.estimatedTotal, "noop_unsafe");
          // Don't return the no-op — fall through to LLM-based compaction
        } else {
          finalContextTokens = postFit.estimatedTotal;
          publishContextEstimate(ctx, postFit.estimatedTotal, "completed_noop");
          return noOpResult;
        }
      }

      // Short conversations → built-in full-pass is fine
      if (messagesToSummarize.length < SELECTIVE_THRESHOLD) {
        publishContextEstimate(ctx, tokensBefore, "builtin_fallback");
        return;
      }

      const compactionStartedAt = Date.now();
      const contextWindow = getContextWindowEstimate(ctx) || PROGRESSIVE_FALLBACK_CONTEXT_WINDOW;
      const configuredKeepRecent = Math.max(0, Number(settings.keepRecentTokens) || 0);
      const safeKeepRecent = clampKeepRecentTokens(configuredKeepRecent, contextWindow);
      if (safeKeepRecent < configuredKeepRecent) {
        log.debug(
          `keepRecentTokens setting ${configuredKeepRecent} exceeds safe ${safeKeepRecent} for ${contextWindow} context; post-compaction fit checks will use the configured kept-window estimate to avoid under-reporting`,
          "warning",
        );
      }

      ctx.ui.setWorkingMessage(`Smart compaction: extracting signal from ${messagesToSummarize.length} messages…`);
      publishContextEstimate(ctx, tokensBefore, "extracting");
      log.debug(
        `Smart compaction: ${messagesToSummarize.length} msgs → selective extraction`,
        "info",
      );

      const promptText = buildSelectivePrompt(
        llmMessages,
        { tokensBefore, previousSummary, fileOps: preparation.fileOps, keptMessagesSummary, turnPrefixSummary },
        customInstructions,
        topicShift,
        humanUserIndexes,
      );

      log.debug(
        `Prompt: ${Math.round(promptText.length / 1000)}k chars (vs ~${Math.round(tokensBefore / 1000)}k tokens full)`,
        "info",
      );
      publishContextEstimate(ctx, estimateCompactionPromptTokens(promptText), "summarizing_prompt");

      // Model — use the session's own model (already session-scoped)
      const model = ctx.model;
      if (!model) {
        log.debug("No model available for smart compaction", "warning");
        return;
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        log.debug(`Compaction model is not configured in pi settings: ${auth.error}`, "warning");
        return;
      }

      const budget = getProgressiveCompactionBudget(model);
      if (budget.forceProgressive || promptText.length > budget.promptBudgetChars) {
        try {
          ctx.ui.setWorkingMessage("Smart compaction: progressive iterative mode…");
          log.debug(
            `Progressive compaction enabled: prompt ${Math.round(promptText.length / 1000)}k chars exceeds ${Math.round(budget.promptBudgetChars / 1000)}k budget for ${budget.contextWindow.toLocaleString()} context`,
            "info",
          );
          const progressiveSummary = await runProgressiveCompaction({
            llmMessages,
            humanUserIndexes,
            model,
            auth,
            settings,
            previousSummary,
            keptMessagesSummary,
            turnPrefixSummary,
            customInstructions,
            fileOps: preparation.fileOps,
            budget,
            abortSignal,
            ctx,
            timeoutMs: 180_000,
            startedAt: compactionStartedAt,
            publishEstimate: (tokens, phase) => publishContextEstimate(ctx, tokens, phase),
          });
          const fullSummary = progressiveSummary.includes("<read-files>") || progressiveSummary.includes("<modified-files>")
            ? progressiveSummary
            : appendFileLists(progressiveSummary, preparation.fileOps);

          // Post-compaction fit verification uses the configured kept-window
          // estimate, not the safe clamp, because the upstream preparation has
          // already selected firstKeptEntryId before this extension runs.
          const postFit = estimatePostCompactionFit(fullSummary, configuredKeepRecent, contextWindow);
          finalContextTokens = postFit.estimatedTotal;
          publishContextEstimate(ctx, postFit.estimatedTotal, "completed_progressive");
          if (!postFit.fits) {
            log.debug(
              `⚠️ Progressive compaction: post-compaction estimate ${postFit.estimatedTotal} tokens still exceeds ${contextWindow} context window (summary ${postFit.summaryTokens}t + kept ${configuredKeepRecent}t + overhead ${postFit.overheadTokens}t, margin ${postFit.margin}t)`,
              "warning",
            );
          }
          log.debug("Progressive compaction complete ✓", "info");
          return {
            compaction: {
              summary: fullSummary,
              firstKeptEntryId,
              tokensBefore,
            } satisfies CompactionResult,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (abortSignal.aborted || /Compaction cancelled/i.test(msg)) return { cancel: true };
          log.debug(`Progressive compaction error: ${msg}; not falling back to single-pass because the prompt already exceeds this model's compaction budget`, "warning");
          return { cancel: true };
        }
      }

      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: promptText }],
          timestamp: Date.now(),
        },
      ];

      const requestedMaxTokens = Math.floor(0.8 * settings.reserveTokens);
      const authForCompletion = auth as { apiKey?: string; headers?: Record<string, string> };

      try {
        const safeOutput = getSafeCompactionMaxTokens(model, promptText, requestedMaxTokens);
        const completionOptions = (model as any).reasoning
          ? { maxTokens: safeOutput.maxTokens, signal: abortSignal, apiKey: authForCompletion.apiKey, headers: authForCompletion.headers, reasoning: "high" as const }
          : { maxTokens: safeOutput.maxTokens, signal: abortSignal, apiKey: authForCompletion.apiKey, headers: authForCompletion.headers };
        ctx.ui.setWorkingMessage("Smart compaction: generating selective summary…");
        publishContextEstimate(ctx, estimateCompactionPromptTokens(promptText), "generating_summary");
        const response = await completeSimple(
          model,
          { systemPrompt: SYSTEM_PROMPT, messages },
          completionOptions,
        );

        if (response.stopReason === "error") {
          log.debug(
            `Smart compaction LLM error: ${(response as any).errorMessage || "unknown"}`,
            "warning",
          );
          return; // fall through to built-in
        }

        const summary = response.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
          .trim();

        if (summary.length < MIN_SUMMARY_CHARS) {
          log.debug(
            "Smart compaction summary too short, falling back to built-in",
            "warning",
          );
          return;
        }

        if (abortSignal.aborted) return { cancel: true };

        // Append deterministic file sections (same format as built-in)
        const { readFiles, modifiedFiles } = fileListsFromOps(
          preparation.fileOps,
        );
        let fullSummary = summary;
        if (
          !summary.includes("<read-files>") &&
          !summary.includes("<modified-files>")
        ) {
          const parts: string[] = [];
          if (readFiles.length > 0) {
            parts.push(`\n<read-files>\n${compressFilePaths(readFiles)}\n</read-files>`);
          }
          if (modifiedFiles.length > 0) {
            parts.push(
              `\n<modified-files>\n${compressFilePaths(modifiedFiles)}\n</modified-files>`,
            );
          }
          if (parts.length) fullSummary += "\n" + parts.join("\n");
        }

        // Post-compaction fit verification uses the configured kept-window
        // estimate, not the safe clamp, because the upstream preparation has
        // already selected firstKeptEntryId before this extension runs.
        const postFit = estimatePostCompactionFit(fullSummary, configuredKeepRecent, contextWindow);
        finalContextTokens = postFit.estimatedTotal;
        publishContextEstimate(
          ctx,
          postFit.estimatedTotal,
          "completed_selective",
        );

        if (!postFit.fits) {
          log.debug(
            `⚠️ Single-pass compaction: post-compaction estimate ${postFit.estimatedTotal} tokens still exceeds ${contextWindow} context window (summary ${postFit.summaryTokens}t + kept ${configuredKeepRecent}t + overhead ${postFit.overheadTokens}t, margin ${postFit.margin}t)`,
            "warning",
          );
        }
        log.debug("Smart compaction complete ✓", "info");

        return {
          compaction: {
            summary: fullSummary,
            firstKeptEntryId,
            tokensBefore,
          } satisfies CompactionResult,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!abortSignal.aborted) {
          log.debug(`Smart compaction error: ${msg}`, "warning");
        }
        // If aborted, return cancel so upstream doesn't access the
        // potentially-cleared _compactionAbortController.
        if (abortSignal.aborted) return { cancel: true };
        return; // fall through to built-in
      }
    } finally {
      // Always broadcast a final context estimate so the meter is never stale
      // after compaction completes, fails, or is cancelled. On success, repeat
      // the post-compaction estimate; on fallthrough/cancel/error, keep the
      // pre-compaction estimate because no extension compaction was applied.
      publishContextEstimate(ctx, finalContextTokens ?? tokensBefore, "compaction_done");
      ctx.ui.setWorkingMessage(undefined);
      ctx.ui.setWorkingIndicator({ frames: [] });
    }
  });
}

export default smartCompaction;
