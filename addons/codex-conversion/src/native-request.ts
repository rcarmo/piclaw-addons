import { isOpenAICodexModel } from "./adapter/codex-model.ts";
export interface NativeModelDescriptor { provider?: string; api?: string; id?: string; input?: readonly string[] }

interface FunctionToolPayload {
	type?: unknown;
	name?: unknown;
}

interface ResponsesPayload {
	tools?: unknown[];
	include?: unknown[];
	[key: string]: unknown;
}

interface ResponsesWebSearchTool {
	type: "web_search";
	external_web_access: true;
	search_content_types?: string[];
}

export function supportsNativeWebSearch(model: NativeModelDescriptor | undefined): boolean {
	return isOpenAICodexModel(model);
}

export function supportsMultimodalNativeWebSearch(model: NativeModelDescriptor | undefined): boolean {
	if (!supportsNativeWebSearch(model)) {
		return false;
	}
	const id = (model?.id ?? "").toLowerCase();
	return !id.includes("spark");
}

function isWebSearchFunctionTool(tool: unknown): tool is FunctionToolPayload {
	return !!tool && typeof tool === "object" && (tool as FunctionToolPayload).type === "function" && (tool as FunctionToolPayload).name === "web_search";
}

export function rewriteNativeWebSearchTool(payload: unknown, model: NativeModelDescriptor | undefined): unknown {
	if (!supportsNativeWebSearch(model) || !payload || typeof payload !== "object") {
		return payload;
	}

	const tools = (payload as ResponsesPayload).tools;
	if (!Array.isArray(tools)) {
		return payload;
	}

	let rewritten = false;
	const nextTools = tools.map((tool) => {
		if (!isWebSearchFunctionTool(tool)) {
			return tool;
		}
		rewritten = true;
		// Match Codex's native tool shape rather than exposing a synthetic function tool.
		const nativeTool: ResponsesWebSearchTool = {
			type: "web_search",
			external_web_access: true,
		};
		if (supportsMultimodalNativeWebSearch(model)) {
			nativeTool.search_content_types = ["text", "image"];
		}
		return nativeTool;
	});

	if (!rewritten) {
		return payload;
	}

	const payloadInclude = (payload as ResponsesPayload).include;
	const include = Array.isArray(payloadInclude)
		? payloadInclude.filter((value): value is string => typeof value === "string")
		: [];
	return {
		...(payload as ResponsesPayload),
		tools: nextTools,
		include: [...new Set([...include, "web_search_call.action.sources", "web_search_call.results"])],
	};
}


interface ImageFunctionToolPayload {
	type?: unknown;
	name?: unknown;
}

interface ImageResponsesPayload {
	tools?: unknown[];
	[key: string]: unknown;
}

interface ResponsesImageGenerationTool {
	type: "image_generation";
	output_format: "png";
}

function supportsImageInputs(model: NativeModelDescriptor | undefined): boolean {
	return Array.isArray(model?.input) && model.input.includes("image");
}

export function supportsOriginalImageDetail(model: NativeModelDescriptor | undefined): boolean {
  return supportsImageInputs(model) && [model?.provider, model?.api, model?.id].some(value => value?.toLowerCase().includes("codex"));
}

export function supportsNativeImageGeneration(model: NativeModelDescriptor | undefined): boolean {
	return isOpenAICodexModel(model) && supportsImageInputs(model);
}

function isImageGenerationFunctionTool(tool: unknown): tool is ImageFunctionToolPayload {
	return !!tool && typeof tool === "object" && (tool as ImageFunctionToolPayload).type === "function" && (tool as ImageFunctionToolPayload).name === "image_generation";
}

export function rewriteNativeImageGenerationTool(payload: unknown, model: NativeModelDescriptor | undefined): unknown {
	if (!supportsNativeImageGeneration(model) || !payload || typeof payload !== "object") {
		return payload;
	}

	const tools = (payload as ImageResponsesPayload).tools;
	if (!Array.isArray(tools)) {
		return payload;
	}

	let rewritten = false;
	const nextTools = tools.map((tool) => {
		if (!isImageGenerationFunctionTool(tool)) {
			return tool;
		}
		rewritten = true;
		const nativeTool: ResponsesImageGenerationTool = {
			type: "image_generation",
			output_format: "png",
		};
		return nativeTool;
	});

	if (!rewritten) {
		return payload;
	}

	return {
		...(payload as ImageResponsesPayload),
		tools: nextTools,
	};
}
