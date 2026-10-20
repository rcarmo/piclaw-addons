import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";

export const IMAGE_GENERATION_UNSUPPORTED_MESSAGE =
	"image_generation is only available with image-capable openai-codex models";
const IMAGE_GENERATION_LOCAL_EXECUTION_MESSAGE =
	"image_generation is a native openai-codex provider tool and should not execute locally";

const IMAGE_GENERATION_PARAMETERS = Type.Unsafe<Record<string, never>>({
	type: "object",
	additionalProperties: false,
});

export { supportsNativeImageGeneration, rewriteNativeImageGenerationTool } from "../native-request.ts";
import { supportsNativeImageGeneration } from "../native-request.ts";

function createEmptyResultComponent(): Container { return new Container(); }

export function createImageGenerationTool(): ToolDefinition<typeof IMAGE_GENERATION_PARAMETERS> {
	const description =
		"Generate an image. Native openai-codex image_generation outputs are saved under `.pi/openai-codex-images/` and mirrored to `.pi/openai-codex-images/latest.png`. Use `view_image` only when pixel-level inspection is necessary.";
	return {
		name: "image_generation",
		label: "image_generation",
		description,
		promptSnippet: description,
		parameters: IMAGE_GENERATION_PARAMETERS,
		prepareArguments: () => ({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!supportsNativeImageGeneration(ctx.model)) {
				throw new Error(IMAGE_GENERATION_UNSUPPORTED_MESSAGE);
			}
			throw new Error(IMAGE_GENERATION_LOCAL_EXECUTION_MESSAGE);
		},
		renderCall(_args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("image_generation"))}`, 0, 0);
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

export function registerImageGenerationTool(pi: ExtensionAPI): void {
	pi.registerTool(createImageGenerationTool());
}
