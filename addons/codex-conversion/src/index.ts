import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCodexRuntimeShell } from "./adapter/runtime-shell.ts";
import {
	CORE_ADAPTER_TOOL_NAMES,
	VIEW_IMAGE_TOOL_NAME,
} from "./adapter/tool-set.ts";
import { clearApplyPatchRenderState, registerApplyPatchTool } from "./tools/apply-patch-tool.ts";
import { isCodexLikeContext, isOpenAICodexContext } from "./adapter/codex-model.ts";
import { applyGitHubCopilotInferenceProfile, type AdapterProfile } from "./adapter/provider-profile.ts";
import { syncAdapterTools } from "./adapter/profile-controller.ts";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";
import {
	IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
	WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
	registerOpenAICodexNativeOutputObserver,
} from "./providers/openai-codex-native-output-observer.ts";
import {
	registerImageGenerationTool,
	rewriteNativeImageGenerationTool,
} from "./tools/image-generation-tool.ts";
import { buildCodexSystemPrompt, extractPiPromptSkills, type PromptSkill } from "./prompt/build-system-prompt.ts";
import { registerViewImageTool, supportsOriginalImageDetail } from "./tools/view-image-tool.ts";
import {
	registerWebSearchTool,
	rewriteNativeWebSearchTool,
	WEB_SEARCH_SESSION_NOTE_TYPE,
} from "./tools/web-search-tool.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";

interface AdapterState {
	profile: AdapterProfile;
	cwd: string;
	previousToolNames?: string[];
	promptSkills: PromptSkill[];
}

const LEGACY_NATIVE_ACTIVITY_MESSAGE_TYPES = new Set([
	WEB_SEARCH_SESSION_NOTE_TYPE,
	WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
	IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
]);

function getCommandArg(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || !("cmd" in args) || typeof args.cmd !== "string") {
		return undefined;
	}
	return args.cmd;
}

function isToolCallOnlyAssistantMessage(message: unknown): boolean {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
		return false;
	}
	if (!("content" in message) || !Array.isArray(message.content) || message.content.length === 0) {
		return false;
	}
	return message.content.every((item) => typeof item === "object" && item !== null && "type" in item && item.type === "toolCall");
}

export default function codexConversion(pi: ExtensionAPI) {
	const tracker = createExecCommandTracker();
	const state: AdapterState = { profile: "native", cwd: process.cwd(), promptSkills: [] };
	const sessions = createExecSessionManager();
	registerOpenAICodexNativeOutputObserver(pi, { getCurrentCwd: () => state.cwd });
	registerApplyPatchTool(pi);
	registerExecCommandTool(pi, tracker, sessions);
	registerWriteStdinTool(pi, sessions);
	registerImageGenerationTool(pi);
	registerWebSearchTool(pi);

	sessions.onSessionExit((sessionId) => {
		tracker.recordSessionFinished(sessionId);
	});

	pi.on("session_start", async (_event, ctx) => {
		state.cwd = ctx.cwd;
		clearApplyPatchRenderState();
		tracker.clear();
		syncAdapter(pi, ctx, state);
	});

	pi.on("model_select", async (_event, ctx) => {
		state.cwd = ctx.cwd;
		syncAdapter(pi, ctx, state);
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "toolResult") return;
		if (isToolCallOnlyAssistantMessage(event.message)) return;
		tracker.resetExplorationGroup();
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName !== "exec_command") {
			tracker.resetExplorationGroup();
			return;
		}
		const command = getCommandArg(event.args);
		if (!command) return;
		tracker.recordStart(event.toolCallId, command);
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== "exec_command") return;
		tracker.recordEnd(event.toolCallId);
	});

	pi.on("session_shutdown", async () => {
		clearApplyPatchRenderState();
		sessions.shutdown();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isCodexLikeContext(ctx)) {
			return undefined;
		}
		return {
			systemPrompt: buildCodexSystemPrompt(event.systemPrompt, {
				skills: state.promptSkills,
				shell: getCodexRuntimeShell(process.env.SHELL),
			}),
		};
	});

	pi.on("before_provider_headers", async (event, ctx) => {
		applyGitHubCopilotInferenceProfile(event.headers, ctx.model);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		state.cwd = ctx.cwd;
		if (!isOpenAICodexContext(ctx)) {
			return undefined;
		}
		return rewriteNativeImageGenerationTool(rewriteNativeWebSearchTool(event.payload, ctx.model), ctx.model);
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter(
			(message) => message.role !== "custom" || !LEGACY_NATIVE_ACTIVITY_MESSAGE_TYPES.has(message.customType),
		),
	}));
}

function syncAdapter(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): void {
	state.promptSkills = extractPiPromptSkills(ctx.getSystemPrompt());

	registerViewImageTool(pi, { allowOriginalDetail: supportsOriginalImageDetail(ctx.model) });

	syncAdapterTools(pi, ctx, state, getAdapterToolNames(ctx));
}

function getAdapterToolNames(ctx: ExtensionContext): string[] {
	const toolNames = [...CORE_ADAPTER_TOOL_NAMES];
	if (Array.isArray(ctx.model?.input) && ctx.model.input.includes("image")) {
		toolNames.push(VIEW_IMAGE_TOOL_NAME);
	}
	return toolNames;
}
