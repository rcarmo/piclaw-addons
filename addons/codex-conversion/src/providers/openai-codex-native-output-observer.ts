import { readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimple as streamBuiltinProvider } from "@earendil-works/pi-ai/compat";
import type { Context, FetchFunction } from "@earendil-works/pi-ai";
import { Box, Image, Spacer, Text } from "@earendil-works/pi-tui";

export const IMAGE_SAVE_DISPLAY_MESSAGE_TYPE = "codex-image-generation-display";
export const WEB_SEARCH_ACTIVITY_MESSAGE_TYPE = "codex-web-search-activity";

const OPENAI_CODEX_IMAGE_DIR = ".pi/openai-codex-images";
const OPENAI_CODEX_LATEST_IMAGE_NAME = "latest.png";
const NATIVE_OUTPUT_TOOL_NAMES = new Set(["image_generation", "web_search"]);

interface SavedGeneratedImage {
	absolutePath: string;
	relativePath: string;
	latestAbsolutePath: string;
	latestRelativePath: string;
	responseId?: string;
	callId: string;
	outputFormat: string;
	revisedPrompt?: string;
}

interface ImageDisplayMessageDetails {
	savedImages: SavedGeneratedImage[];
}

interface SurfacedWebSearch {
	callId: string;
	status?: string;
	query?: string;
	queries: string[];
	sources: Array<{ title?: string; url: string }>;
}

type PendingActivity =
	| { kind: "image"; savedImage: SavedGeneratedImage; imageData: { data: string; mimeType: string } }
	| { kind: "web-search"; search: SurfacedWebSearch };

interface NativeOutputItem {
	type?: string;
	id?: string;
	result?: string | null;
	output_format?: string;
	revised_prompt?: string;
	status?: string;
	action?: unknown;
	results?: unknown;
}

interface ResponsesEvent {
	type?: string;
	response?: { id?: string };
	item?: NativeOutputItem;
}

/**
 * pi-ai owns ordinary OpenAI Codex requests. Native output capture is needed
 * only when a turn advertises a provider tool whose completed output item is
 * not exposed by pi-ai 0.84.4.
 */
export function requiresNativeOutputCapture(context: Pick<Context, "tools">): boolean {
	return context.tools?.some((tool) => NATIVE_OUTPUT_TOOL_NAMES.has(tool.name)) ?? false;
}

function normalizeImageOutputFormat(value: string | undefined): "png" | "jpg" | "jpeg" | "webp" {
	const format = (value ?? "png").toLowerCase();
	return format === "jpg" || format === "jpeg" || format === "webp" ? format : "png";
}

function safeFilePart(value: string | undefined, fallback: string): string {
	const normalized = (value ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || fallback;
	if (normalized.length <= 24) return normalized;
	return `${normalized.slice(0, 16)}-${normalized.slice(-7)}`;
}

async function findWorkspaceRoot(cwd: string): Promise<string> {
	let current = resolve(cwd);
	while (true) {
		try {
			await stat(join(current, ".git"));
			return current;
		} catch {
			// Continue to the parent.
		}
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

export async function saveOpenAICodexGeneratedImage(
	cwd: string,
	image: { responseId?: string; callId: string; result: string; outputFormat?: string; revisedPrompt?: string },
): Promise<SavedGeneratedImage> {
	const workspaceRoot = await findWorkspaceRoot(cwd);
	const outputFormat = normalizeImageOutputFormat(image.outputFormat);
	const imageDirectory = join(workspaceRoot, OPENAI_CODEX_IMAGE_DIR);
	const filename = `${safeFilePart(image.callId, "image")}-${safeFilePart(image.responseId, "response")}.${outputFormat}`;
	const absolutePath = join(imageDirectory, filename);
	const latestAbsolutePath = join(imageDirectory, OPENAI_CODEX_LATEST_IMAGE_NAME);
	const bytes = Buffer.from(image.result, "base64");
	await mkdir(imageDirectory, { recursive: true });
	await Promise.all([writeFile(absolutePath, bytes), writeFile(latestAbsolutePath, bytes)]);
	return {
		absolutePath,
		relativePath: relative(workspaceRoot, absolutePath),
		latestAbsolutePath,
		latestRelativePath: relative(workspaceRoot, latestAbsolutePath),
		responseId: image.responseId,
		callId: image.callId,
		outputFormat,
		revisedPrompt: image.revisedPrompt,
	};
}

export function buildGeneratedImageDisplayText(
	savedImage: SavedGeneratedImage,
	options?: { expanded?: boolean },
): string {
	const lines = options?.expanded && savedImage.revisedPrompt ? [`Prompt: ${savedImage.revisedPrompt}`] : [];
	lines.push(`File: ${savedImage.relativePath}`);
	return lines.join("\n");
}

function extractWebSearch(item: NativeOutputItem | undefined): SurfacedWebSearch | undefined {
	if (item?.type !== "web_search_call" || typeof item.id !== "string") return undefined;
	const action = typeof item.action === "object" && item.action !== null
		? item.action as Record<string, unknown>
		: undefined;
	const query = typeof action?.query === "string" ? action.query : undefined;
	const queries = Array.isArray(action?.queries)
		? action.queries.filter((value): value is string => typeof value === "string")
		: [];
	const sources: Array<{ title?: string; url: string }> = [];
	const seen = new Set<string>();
	const addSource = (url: unknown, title?: unknown) => {
		if (typeof url !== "string" || seen.has(url)) return;
		seen.add(url);
		sources.push(typeof title === "string" ? { title, url } : { url });
	};
	if (Array.isArray(item.results)) {
		for (const result of item.results) {
			if (typeof result === "object" && result !== null) {
				const record = result as Record<string, unknown>;
				addSource(record.url, record.title);
			}
		}
	}
	if (Array.isArray(action?.sources)) {
		for (const source of action.sources) {
			if (typeof source === "object" && source !== null) addSource((source as Record<string, unknown>).url);
		}
	}
	return {
		callId: item.id,
		status: typeof item.status === "string" ? item.status : undefined,
		query,
		queries,
		sources,
	};
}

export function buildWebSearchActivityMessage(searches: SurfacedWebSearch[]): string {
	return searches.map((search, index) => {
		const lines = [searches.length > 1 ? `Web search results ${index + 1}` : "Web search results"];
		const queries = search.queries.length ? search.queries : search.query ? [search.query] : [];
		if (queries.length) lines.push("Queries:", ...queries.map((query) => `- ${query}`));
		if (search.sources.length) {
			lines.push("Sources:", ...search.sources.slice(0, 5).map((source) => `- ${source.title ? `${source.title} — ` : ""}${source.url}`));
		}
		return lines.join("\n");
	}).join("\n\n");
}

export function buildWebSearchSummaryText(searches: SurfacedWebSearch[]): string {
	return searches.length === 1 ? "Searched the web once" : `Searched the web ${searches.length} times`;
}

export function parseResponsesSSE(text: string): ResponsesEvent[] {
	const normalized = text.replace(/\r\n/g, "\n");
	const events: ResponsesEvent[] = [];
	for (const block of normalized.split("\n\n")) {
		const data = block.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") continue;
		try {
			events.push(JSON.parse(data) as ResponsesEvent);
		} catch {
			// The provider stream owns protocol validation. Capture stays best-effort.
		}
	}
	return events;
}

async function captureNativeOutputResponse(
	response: Response,
	cwd: string,
	requestPrompt: string | undefined,
	onActivity: (activity: PendingActivity) => void,
): Promise<void> {
	if (!response.ok) return;
	const events = parseResponsesSSE(await response.text());
	let responseId: string | undefined;
	for (const event of events) {
		if (event.type === "response.created" && typeof event.response?.id === "string") responseId = event.response.id;
		if (event.type !== "response.output_item.done") continue;
		const item = event.item;
		if (item?.type === "image_generation_call" && typeof item.id === "string" && typeof item.result === "string") {
			const outputFormat = normalizeImageOutputFormat(item.output_format);
			const savedImage = await saveOpenAICodexGeneratedImage(cwd, {
				responseId,
				callId: item.id,
				result: item.result,
				outputFormat,
				revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : requestPrompt,
			});
			onActivity({ kind: "image", savedImage, imageData: { data: item.result, mimeType: `image/${outputFormat}` } });
			continue;
		}
		const search = extractWebSearch(item);
		if (search) onActivity({ kind: "web-search", search });
	}
}

function latestUserText(context: Context): string | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content.trim() || undefined;
		const text = message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
		if (text) return text;
	}
	return undefined;
}

function createCaptureFetch(
	baseFetch: FetchFunction,
	capture: (response: Response) => Promise<void>,
	captureTasks: Set<Promise<void>>,
): FetchFunction {
	const captureFetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const response = await baseFetch(input, init);
		if (response.ok && response.body) {
			try {
				const cloned = response.clone();
				const task = capture(cloned)
					.catch((error) => console.warn("[piclaw-addon-codex-conversion] Native output capture failed", error))
					.finally(() => captureTasks.delete(task));
				captureTasks.add(task);
			} catch (error) {
				console.warn("[piclaw-addon-codex-conversion] Native output response could not be cloned", error);
			}
		}
		return response;
	};
	return captureFetch as FetchFunction;
}

export function registerOpenAICodexNativeOutputObserver(
	pi: ExtensionAPI,
	options: {
		getCurrentCwd: () => string;
		streamBuiltin?: typeof streamBuiltinProvider;
	},
): void {
	const pendingActivities: PendingActivity[] = [];
	const imagePreviewCache = new Map<string, { data: string; mimeType: string }>();
	const captureTasks = new Set<Promise<void>>();
	const streamBuiltin = options.streamBuiltin ?? streamBuiltinProvider;

	const flushPendingMessages = () => {
		const activities = pendingActivities.splice(0);
		for (let index = 0; index < activities.length; index++) {
			const activity = activities[index]!;
			if (activity.kind === "image") {
				imagePreviewCache.set(activity.savedImage.absolutePath, activity.imageData);
				pi.sendMessage({
					customType: IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
					content: [{ type: "text", text: buildGeneratedImageDisplayText(activity.savedImage) }],
					display: true,
					details: { savedImages: [activity.savedImage] } satisfies ImageDisplayMessageDetails,
				}, { triggerTurn: false });
				continue;
			}
			const searches = [activity.search];
			while (activities[index + 1]?.kind === "web-search") searches.push((activities[++index] as Extract<PendingActivity, { kind: "web-search" }>).search);
			pi.sendMessage({
				customType: WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
				content: buildWebSearchActivityMessage(searches),
				display: true,
				details: { searches },
			}, { triggerTurn: false });
		}
	};

	const awaitCaptureAndFlush = async () => {
		await Promise.allSettled([...captureTasks]);
		flushPendingMessages();
	};

	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple: (model, context, streamOptions) => {
			if (!requiresNativeOutputCapture(context)) return streamBuiltin(model, context, streamOptions);
			const cwd = options.getCurrentCwd();
			const requestPrompt = latestUserText(context);
			const baseFetch = streamOptions?.fetch ?? globalThis.fetch;
			return streamBuiltin(model, context, {
				...streamOptions,
				transport: "sse",
				fetch: createCaptureFetch(
					baseFetch,
					(response) => captureNativeOutputResponse(response, cwd, requestPrompt, (activity) => pendingActivities.push(activity)),
					captureTasks,
				),
			});
		},
	});

	pi.on("session_start", () => {
		pendingActivities.length = 0;
		imagePreviewCache.clear();
	});
	pi.on("agent_end", awaitCaptureAndFlush);
	pi.on("session_shutdown", awaitCaptureAndFlush);

	pi.registerMessageRenderer<ImageDisplayMessageDetails>(IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, (message, renderOptions, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[image_generation]")), 0, 0));
		const savedImage = message.details?.savedImages?.[0];
		const content = savedImage
			? buildGeneratedImageDisplayText(savedImage, { expanded: renderOptions.expanded })
			: typeof message.content === "string"
				? message.content
				: message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		box.addChild(new Text(`\n${theme.fg("customMessageText", content)}`, 0, 0));
		if (savedImage) {
			let preview = imagePreviewCache.get(savedImage.absolutePath);
			try {
				preview ??= { data: readFileSync(savedImage.absolutePath).toString("base64"), mimeType: `image/${savedImage.outputFormat}` };
				imagePreviewCache.set(savedImage.absolutePath, preview);
			} catch {
				preview = undefined;
			}
			if (preview) {
				box.addChild(new Spacer(1));
				box.addChild(new Image(preview.data, preview.mimeType, { fallbackColor: (text) => theme.fg("customMessageText", text) }, { maxWidthCells: 60 }));
			}
		}
		return box;
	});

	pi.registerMessageRenderer<{ searches?: SurfacedWebSearch[] }>(WEB_SEARCH_ACTIVITY_MESSAGE_TYPE, (message, renderOptions, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const searches = message.details?.searches ?? [];
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(buildWebSearchSummaryText(searches))), 0, 0));
		if (renderOptions.expanded) {
			const content = typeof message.content === "string"
				? message.content
				: message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
			box.addChild(new Text(`\n${theme.fg("customMessageText", content)}`, 0, 0));
		}
		return box;
	});
}
