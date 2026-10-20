import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";

export const WEB_SEARCH_UNSUPPORTED_MESSAGE = "web_search is only available with the openai-codex provider";
const WEB_SEARCH_LOCAL_EXECUTION_MESSAGE =
	"web_search is a native openai-codex provider tool and should not execute locally";
export const WEB_SEARCH_SESSION_NOTE_TYPE = "codex-web-search-session-note";

const WEB_SEARCH_PARAMETERS = Type.Unsafe<Record<string, never>>({
	type: "object",
	additionalProperties: false,
});

export { supportsNativeWebSearch, supportsMultimodalNativeWebSearch, rewriteNativeWebSearchTool } from "../native-request.ts";
import { supportsNativeWebSearch } from "../native-request.ts";

function createEmptyResultComponent(): Container { return new Container(); }

export function createWebSearchTool(): ToolDefinition<typeof WEB_SEARCH_PARAMETERS> {
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the web for sources relevant to the current task. Use it when you need up-to-date information, external references, or broader context beyond the workspace.",
		promptSnippet:
			"Search the web for sources relevant to the current task. Use it when you need up-to-date information, external references, or broader context beyond the workspace.",
		parameters: WEB_SEARCH_PARAMETERS,
		prepareArguments: () => ({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!supportsNativeWebSearch(ctx.model)) {
				throw new Error(WEB_SEARCH_UNSUPPORTED_MESSAGE);
			}
			throw new Error(WEB_SEARCH_LOCAL_EXECUTION_MESSAGE);
		},
		renderCall(_args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("web_search"))}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) {
				return createEmptyResultComponent();
			}
			const textBlock = result.content.find((item) => item.type === "text");
			const text = textBlock?.type === "text" ? textBlock.text : "(no output)";
			return new Text(theme.fg("dim", text), 0, 0);
		},
	};
}

export function registerWebSearchTool(pi: ExtensionAPI): void {
	pi.registerTool(createWebSearchTool());
}
