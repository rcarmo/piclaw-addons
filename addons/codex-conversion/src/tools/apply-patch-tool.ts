import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { executePatch } from "../patch/core.ts";
import { ExecutePatchError, type ExecutePatchResult } from "../patch/types.ts";
import { formatApplyPatchSummary, renderApplyPatchCall } from "./apply-patch-rendering.ts";

const APPLY_PATCH_PARAMETERS = Type.Object({
	input: Type.String({
		description: "Full patch text. Use *** Begin Patch / *** End Patch with Add/Update/Delete File sections.",
	}),
});

interface ApplyPatchRenderState {
	cwd: string;
	patchText: string;
	collapsed: string;
	expanded: string;
	status: "pending" | "partial_failure" | "failed";
	failedTargets?: string[];
}

import { formatPatchSuccess, formatPatchError, describeFailedActions, type ApplyPatchToolDetails } from "../patch/tool-result.ts";

const applyPatchRenderStates = new Map<string, ApplyPatchRenderState>();

interface ApplyPatchRenderContextLike {
	toolCallId?: string;
	cwd?: string;
	expanded?: boolean;
	argsComplete?: boolean;
}

function parseApplyPatchParams(params: unknown): { patchText: string } {
	if (!params || typeof params !== "object" || !("input" in params) || typeof params.input !== "string") {
		throw new Error("apply_patch requires a string 'input' parameter");
	}
	return { patchText: params.input };
}

function prepareApplyPatchArguments(args: unknown): { input: string } {
	if (args && typeof args === "object") {
		if ("input" in args && typeof args.input === "string") {
			return { input: args.input };
		}
		if ("patchText" in args && typeof args.patchText === "string") {
			return { input: args.patchText };
		}
		if ("patch" in args && typeof args.patch === "string") {
			return { input: args.patch };
		}
	}
	return args as { input: string };
}

function isApplyPatchToolDetails(details: unknown): details is ApplyPatchToolDetails {
	return typeof details === "object" && details !== null && "status" in details && "result" in details;
}

function setApplyPatchRenderState(
	toolCallId: string,
	patchText: string,
	cwd: string,
	status: "pending" | "partial_failure" | "failed" = "pending",
	failedTargets?: string[],
): void {
	const collapsed = formatApplyPatchSummary(patchText, cwd);
	const expanded = renderApplyPatchCall(patchText, cwd);
	applyPatchRenderStates.set(toolCallId, {
		cwd,
		patchText,
		collapsed,
		expanded,
		status,
		failedTargets,
	});
}

function markApplyPatchPartialFailure(toolCallId: string, failedTargets?: string[]): void {
	markApplyPatchFailure(toolCallId, "partial_failure", failedTargets);
}

function markApplyPatchFailure(toolCallId: string, status: "partial_failure" | "failed", failedTargets?: string[]): void {
	const existing = applyPatchRenderStates.get(toolCallId);
	if (!existing) {
		return;
	}
	applyPatchRenderStates.set(toolCallId, {
		...existing,
		status,
		failedTargets,
	});
}

function renderPartialFailureCall(
	text: string,
	theme: { fg(role: string, text: string): string },
	failedTargets?: string[],
): string {
	const lines = text.split("\n");
	if (lines.length === 0) {
		return theme.fg("warning", "• Edit partially failed");
	}
	lines[0] = lines[0].replace(/^• (Added|Edited|Deleted)\b/, "• Edit partially failed");
	const failedLineIndexes = new Set<number>();
	if (failedTargets) {
		for (let i = 0; i < lines.length; i += 1) {
			for (const failedTarget of failedTargets) {
				const failedLine = markFailedTargetLine(lines[i], failedTarget);
				if (failedLine) {
					lines[i] = failedLine;
					failedLineIndexes.add(i);
					break;
				}
			}
		}
	}
	return lines
		.map((line, index) => {
			if (failedLineIndexes.has(index)) {
				return theme.fg("error", line);
			}
			if (index === 0) {
				return theme.fg("warning", line);
			}
			return line;
		})
		.join("\n");
}

function renderFailedCall(
	text: string,
	theme: { fg(role: string, text: string): string },
	failedTargets?: string[],
): string {
	const lines = text.split("\n");
	if (lines.length === 0) {
		return theme.fg("error", "• Edit failed");
	}
	lines[0] = lines[0].replace(/^• (Added|Edited|Deleted)\b/, "• Edit failed");
	const failedLineIndexes = new Set<number>();
	if (failedTargets) {
		for (let i = 0; i < lines.length; i += 1) {
			for (const failedTarget of failedTargets) {
				const failedLine = markFailedTargetLine(lines[i], failedTarget);
				if (failedLine) {
					lines[i] = failedLine;
					failedLineIndexes.add(i);
					break;
				}
			}
		}
	}
	return lines
		.map((line, index) => {
			if (failedLineIndexes.has(index) || index === 0) {
				return theme.fg("error", line);
			}
			return line;
		})
		.join("\n");
}

function markFailedTargetLine(line: string, failedTarget: string): string | undefined {
	const suffixMatch = line.match(/ \(\+\d+ -\d+\)$/);
	if (!suffixMatch) {
		return undefined;
	}
	const suffix = suffixMatch[0];
	const prefixAndTarget = line.slice(0, -suffix.length);
	const candidatePrefixes = ["• Edit partially failed ", "• Added ", "• Edited ", "• Deleted ", "  └ ", "    "];
	for (const prefix of candidatePrefixes) {
		if (prefixAndTarget === `${prefix}${failedTarget}`) {
			return `${prefix}${failedTarget} failed${suffix}`;
		}
	}
	return undefined;
}

export type { ExecutePatchResult } from "../patch/types.ts";

export function clearApplyPatchRenderState(): void {
	applyPatchRenderStates.clear();
}

const renderApplyPatchCallWithOptionalContext: any = (
	args: { input?: unknown },
	theme: { fg(role: string, text: string): string; bold(text: string): string },
	context?: ApplyPatchRenderContextLike,
) => {
	if (context?.argsComplete === false) {
		return new Text(`${theme.fg("dim", "•")} ${theme.bold("Patching")}`, 0, 0);
	}
	const patchText = typeof args.input === "string" ? args.input : "";
	if (patchText.trim().length === 0) {
		return new Text(`${theme.fg("dim", "•")} ${theme.bold("Patching")}`, 0, 0);
	}
	const cached = context?.toolCallId ? applyPatchRenderStates.get(context.toolCallId) : undefined;
	const cwd = context?.cwd ?? cached?.cwd;
	const effectivePatchText = cached?.patchText ?? patchText;
	const baseText = context?.expanded
		? cached?.expanded ?? renderApplyPatchCall(effectivePatchText, cwd)
		: cached?.collapsed ?? formatApplyPatchSummary(effectivePatchText, cwd);
	if (baseText.trim().length === 0) {
		if (cached?.status === "failed") {
			return new Text(theme.fg("error", "• Edit failed"), 0, 0);
		}
		return new Text(`${theme.fg("dim", "•")} ${theme.bold("Patching")}`, 0, 0);
	}
	const text =
		cached?.status === "partial_failure"
			? renderPartialFailureCall(baseText, theme, cached.failedTargets)
			: cached?.status === "failed"
				? renderFailedCall(baseText, theme, cached.failedTargets)
				: baseText;
	return new Text(text, 0, 0);
};

export function registerApplyPatchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description: "Use `apply_patch` to edit files. Send the full patch in `input`.",
		promptSnippet: "Edit files with a patch.",
		promptGuidelines: [
			"Prefer apply_patch for focused textual edits instead of rewriting whole files.",
			"When one task needs coordinated edits across multiple files, send them in a single apply_patch call when one coherent patch will do.",
		],
		parameters: APPLY_PATCH_PARAMETERS,
		prepareArguments: prepareApplyPatchArguments,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				throw new Error("apply_patch aborted");
			}

			const typedParams = parseApplyPatchParams(params);
			setApplyPatchRenderState(toolCallId, typedParams.patchText, ctx.cwd);
			let result: ExecutePatchResult;
			try {
				result = executePatch({ cwd: ctx.cwd, patchText: typedParams.patchText });
			} catch (error) {
                if (error instanceof ExecutePatchError) {
                    const targets = describeFailedActions(error, ctx.cwd);
                    if (error.hasPartialSuccess()) markApplyPatchPartialFailure(toolCallId, targets);
                    else markApplyPatchFailure(toolCallId, "failed", targets);
                } else markApplyPatchFailure(toolCallId, "failed");
                return formatPatchError(error, ctx.cwd);
            }
            return formatPatchSuccess(result);
		},
		renderCall: renderApplyPatchCallWithOptionalContext,
		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) {
				return new Text(`${theme.fg("dim", "•")} ${theme.bold("Patching")}`, 0, 0);
			}

			if (!isApplyPatchToolDetails(result.details)) {
				return new Container();
			}

			if (result.details.status === "partial_failure") {
				return new Container();
			}

			return new Container();
		},
	});
}
