import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";

import type { CodexLikeModelDescriptor } from "./codex-model.ts";

export type AdapterProfile = "native" | "codex-tools" | "copilot-tools";

export const GITHUB_COPILOT_INFERENCE_PROFILE = Object.freeze({
	userAgent: "GitHubCopilotChat/0.48.1",
	editorVersion: "vscode/1.136.0",
	editorPluginVersion: "copilot-chat/0.48.1",
	integrationId: "vscode-chat",
	reviewedAt: "2026-09-03",
});

export function isGitHubCopilotInferenceProfileStale(
	asOf = new Date(),
	maxAgeDays = 90,
): boolean {
	const reviewedAt = Date.parse(`${GITHUB_COPILOT_INFERENCE_PROFILE.reviewedAt}T00:00:00Z`);
	return asOf.getTime() - reviewedAt > maxAgeDays * 24 * 60 * 60 * 1000;
}

export function resolveAdapterProfile(
	model: Partial<CodexLikeModelDescriptor> | null | undefined,
): AdapterProfile {
	if (!model) return "native";
	const provider = (model.provider ?? "").toLowerCase();
	const api = (model.api ?? "").toLowerCase();
	const id = (model.id ?? "").toLowerCase();
	if (provider === "openai-codex" || api === "openai-codex-responses") {
		return "codex-tools";
	}
	if (provider === "github-copilot" && id.startsWith("gpt")) {
		return "copilot-tools";
	}
	return "native";
}

function setHeader(headers: ProviderHeaders, name: string, value: string): void {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === name.toLowerCase() && key !== name) delete headers[key];
	}
	headers[name] = value;
}

/** Apply the tested VS Code Copilot Chat identity to inference requests only. */
export function applyGitHubCopilotInferenceProfile(
	headers: ProviderHeaders,
	model: Pick<Model<any>, "provider"> | null | undefined,
): boolean {
	if ((model?.provider ?? "").toLowerCase() !== "github-copilot") return false;
	setHeader(headers, "User-Agent", GITHUB_COPILOT_INFERENCE_PROFILE.userAgent);
	setHeader(headers, "Editor-Version", GITHUB_COPILOT_INFERENCE_PROFILE.editorVersion);
	setHeader(headers, "Editor-Plugin-Version", GITHUB_COPILOT_INFERENCE_PROFILE.editorPluginVersion);
	return true;
}
