import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveAdapterProfile } from "./provider-profile.ts";

export interface CodexLikeModelDescriptor {
	provider: string;
	api: string;
	id: string;
}

export function isOpenAICodexModel(model: Partial<CodexLikeModelDescriptor> | null | undefined): boolean {
	if (!model) return false;
	return (model.provider ?? "").toLowerCase() === "openai-codex";
}

// Keep model detection intentionally conservative. The adapter replaces the
// system prompt and tool surface, so false positives are worse than misses.
export function isCodexLikeModel(model: Partial<CodexLikeModelDescriptor> | null | undefined): boolean {
	return resolveAdapterProfile(model) !== "native";
}

export function isCodexLikeContext(ctx: ExtensionContext): boolean {
	return isCodexLikeModel(ctx.model);
}

export function isOpenAICodexContext(ctx: ExtensionContext): boolean {
	return isOpenAICodexModel(ctx.model);
}
