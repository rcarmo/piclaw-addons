import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AdapterProfile } from "./provider-profile.ts";
import { STATUS_KEY, STATUS_LABELS } from "./tool-set.ts";

export function setAdapterStatus(ctx: ExtensionContext, profile: AdapterProfile): void {
	if (ctx.mode !== "tui") return;
	const label = profile === "native" ? undefined : ctx.ui.theme.fg("accent", STATUS_LABELS[profile]);
	ctx.ui.setStatus(STATUS_KEY, label);
}
