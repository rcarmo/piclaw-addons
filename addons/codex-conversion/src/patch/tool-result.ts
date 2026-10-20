import { isAbsolute, relative } from "node:path";
import { ExecutePatchError, type ExecutePatchResult } from "./types.ts";
interface ApplyPatchSuccessDetails {
	status: "success";
	result: ExecutePatchResult;
}

interface ApplyPatchPartialFailureDetails {
	status: "partial_failure";
	result: ExecutePatchResult;
	error: string;
	failedTargets?: string[];
	appliedFiles: string[];
	failedFiles: string[];
	recoveryInstructions: {
		mustReadFiles: string[];
		mustNotReadFiles: string[];
	};
}

export type ApplyPatchToolDetails = ApplyPatchSuccessDetails | ApplyPatchPartialFailureDetails;


export function formatPatchTarget(path: string, movePath: string | undefined, cwd: string): string {
	const from = displayPath(path, cwd);
	if (!movePath) {
		return from;
	}
	return `${from} → ${displayPath(movePath, cwd)}`;
}

function displayPath(path: string, cwd: string): string {
	if (!isAbsolute(path)) {
		return path;
	}

	const relativePath = relative(cwd, path);
	if (relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
		return relativePath;
	}

	return path;
}


function summarizePatchCounts(result: ExecutePatchResult): string {
	return [
		`changed ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"}`,
		`created ${result.createdFiles.length}`,
		`deleted ${result.deletedFiles.length}`,
		`moved ${result.movedFiles.length}`,
	].join(", ");
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)));
}

function getFailedPaths(error: ExecutePatchError): string[] {
	return uniqueStrings(
		error.failures.flatMap(({ action }) => [action.path, action.type === "update" ? action.movePath : undefined]),
	);
}

function getAppliedPaths(result: ExecutePatchResult, failedFiles: string[]): string[] {
	return result.changedFiles.filter((path) => !failedFiles.includes(path));
}

function buildPartialFailureMessage(message: string, failedFiles: string[], appliedFiles: string[]): string {
	const lines = [message];
	if (failedFiles.length > 0) {
		lines.push(`Failed file${failedFiles.length === 1 ? "" : "s"}: ${failedFiles.join(", ")}`);
		lines.push(`Recovery: MUST read ${failedFiles.join(", ")} before retrying.`);
	}
	if (appliedFiles.length > 0) {
		lines.push("Earlier file actions in this patch were already applied.");
		lines.push("Recovery: MUST NOT reread other files from this patch unless a specific dependency requires it.");
	}
	return lines.join("\n");
}

function describeFailedActions(error: ExecutePatchError, cwd: string): string[] {
	return uniqueStrings(
		error.failures.map(({ action }) => formatPatchTarget(action.path, action.type === "update" ? action.movePath : undefined, cwd)),
	);
}


export function formatPatchSuccess(result: ExecutePatchResult) {
			const summary = [
				"Applied patch successfully.",
				`Changed files: ${result.changedFiles.length}`,
				`Created files: ${result.createdFiles.length}`,
				`Deleted files: ${result.deletedFiles.length}`,
				`Moved files: ${result.movedFiles.length}`,
				`Fuzz: ${result.fuzz}`,
			].join("\n");

			return {
				content: [{ type: "text" as const, text: summary }],
				details: {
					status: "success",
					result,
				} satisfies ApplyPatchSuccessDetails,
			};
}
export function formatPatchError(error: unknown, cwd: string) {
				if (error instanceof ExecutePatchError) {
					const partial = error.hasPartialSuccess();
					const failedTargets = describeFailedActions(error, cwd);
					const failedTargetSummary = failedTargets.join(", ");
					const prefix = partial
						? `apply_patch partially failed after ${summarizePatchCounts(error.result)}`
						: "apply_patch failed";
					const message = failedTargetSummary ? `${prefix} while patching ${failedTargetSummary}: ${error.message}` : `${prefix}: ${error.message}`;
					if (partial) {
						const failedFiles = getFailedPaths(error);
						const appliedFiles = getAppliedPaths(error.result, failedFiles);
						const recoveryMessage = buildPartialFailureMessage(message, failedFiles, appliedFiles);
						return {
							content: [{ type: "text" as const, text: recoveryMessage }],
							details: {
								status: "partial_failure",
								result: error.result,
								error: recoveryMessage,
								failedTargets,
								appliedFiles,
								failedFiles,
								recoveryInstructions: {
									mustReadFiles: failedFiles,
									mustNotReadFiles: appliedFiles,
								},
							} satisfies ApplyPatchPartialFailureDetails,
						};
					}
					throw new Error(message);
				}
				throw error;
}
export { describeFailedActions };
