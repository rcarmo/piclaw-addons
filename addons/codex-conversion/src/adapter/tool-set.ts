export const STATUS_KEY = "codex-adapter";
export const STATUS_LABELS = {
	"codex-tools": "Codex tools",
	"copilot-tools": "Copilot tools",
} as const;

export const DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write"];

export const CORE_ADAPTER_TOOL_NAMES = ["exec_command", "write_stdin", "apply_patch"];
export const IMAGE_GENERATION_TOOL_NAME = "image_generation";
export const VIEW_IMAGE_TOOL_NAME = "view_image";
export const WEB_SEARCH_TOOL_NAME = "web_search";

const MANAGED_ADAPTER_TOOL_NAMES = [
	...CORE_ADAPTER_TOOL_NAMES,
	WEB_SEARCH_TOOL_NAME,
	IMAGE_GENERATION_TOOL_NAME,
	VIEW_IMAGE_TOOL_NAME,
];

const ON_DEMAND_ADAPTER_TOOL_NAMES = [WEB_SEARCH_TOOL_NAME, IMAGE_GENERATION_TOOL_NAME];

export function mergeAdapterTools(activeTools: string[], adapterTools: string[]): string[] {
	const preservedTools = activeTools.filter(
		(toolName) =>
			!DEFAULT_TOOL_NAMES.includes(toolName) &&
			(!MANAGED_ADAPTER_TOOL_NAMES.includes(toolName) || ON_DEMAND_ADAPTER_TOOL_NAMES.includes(toolName)),
	);
	return [...adapterTools, ...preservedTools];
}

export function restoreTools(previousTools: string[], activeTools: string[]): string[] {
	const restored = [...previousTools];
	for (const toolName of activeTools) {
		if (!MANAGED_ADAPTER_TOOL_NAMES.includes(toolName) && !restored.includes(toolName)) restored.push(toolName);
	}
	return restored;
}

export function hasAdapterTools(activeTools: string[]): boolean {
	return activeTools.some((toolName) => MANAGED_ADAPTER_TOOL_NAMES.includes(toolName));
}
