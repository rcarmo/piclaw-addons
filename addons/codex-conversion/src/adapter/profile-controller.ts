import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveAdapterProfile, type AdapterProfile } from "./provider-profile.ts";
import { setAdapterStatus } from "./ui-status.ts";
import { DEFAULT_TOOL_NAMES, hasAdapterTools, mergeAdapterTools, restoreTools } from "./tool-set.ts";

export interface AdapterActivationState {
	profile: AdapterProfile;
	previousToolNames?: string[];
}

type AdapterToolController = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;

export function syncAdapterTools(
	pi: AdapterToolController,
	ctx: ExtensionContext,
	state: AdapterActivationState,
	adapterToolNames: string[],
): AdapterProfile {
	const profile = resolveAdapterProfile(ctx.model);
	if (profile !== "native") {
		if (state.profile === "native") state.previousToolNames = pi.getActiveTools();
		state.profile = profile;
		pi.setActiveTools(mergeAdapterTools(pi.getActiveTools(), adapterToolNames));
		setAdapterStatus(ctx, profile);
		return profile;
	}

	const previousToolNames = state.previousToolNames ?? DEFAULT_TOOL_NAMES;
	if (state.profile !== "native" || hasAdapterTools(pi.getActiveTools())) {
		pi.setActiveTools(restoreTools(previousToolNames, pi.getActiveTools()));
	}
	state.profile = "native";
	setAdapterStatus(ctx, "native");
	return profile;
}
