/** Invocation-local ports. Every effect port must check assertCurrent at its effect boundary. */
import { resolve } from "node:path";
import { createImageGenerationTool, IMAGE_GENERATION_UNSUPPORTED_MESSAGE } from "./tools/image-generation-tool.ts";
import { createWebSearchTool, WEB_SEARCH_UNSUPPORTED_MESSAGE } from "./tools/web-search-tool.ts";
import { createViewImageTool, parseViewImageParams } from "./tools/view-image-tool.ts";
import { supportsNativeImageGeneration, supportsNativeWebSearch, supportsOriginalImageDetail, type NativeModelDescriptor } from "./native-request.ts";

export type NativeProviderResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details?: unknown };
export interface NativeProviderInvocation {
  chatId: string;
  cwd: string;
  model: NativeModelDescriptor;
  signal?: AbortSignal;
  assertCurrent(): void;
}
export interface NativeProviderToolPorts extends NativeProviderInvocation {
  /** Owns stat/read, image decoding/resizing. Check invocation at actual read boundary. */
  readImage(input: NativeProviderInvocation & { path: string; original: boolean; toolCallId: string }): Promise<NativeProviderResult>;
}
function check(p: NativeProviderInvocation) {
  p.signal?.throwIfAborted(); p.assertCurrent();
}
function invocation(p: NativeProviderToolPorts, signal?: AbortSignal): NativeProviderInvocation {
  const combined = signal && p.signal ? AbortSignal.any([signal, p.signal]) : signal ?? p.signal;
  return { chatId: p.chatId, cwd: p.cwd, model: p.model, signal: combined,
    assertCurrent() { combined?.throwIfAborted(); p.assertCurrent(); } };
}
export function createNativeWebSearchTool(p: NativeProviderToolPorts) {
  return { ...createWebSearchTool(), async execute(_id: string, _params: unknown, signal?: AbortSignal) {
    const i = invocation(p, signal); check(i);
    if (!supportsNativeWebSearch(i.model)) throw Error(WEB_SEARCH_UNSUPPORTED_MESSAGE);
    throw Error("web_search is a native openai-codex provider tool and should not execute locally");
  } };
}
export function createNativeImageGenerationTool(p: NativeProviderToolPorts) {
  return { ...createImageGenerationTool(), async execute(_id: string, _params: unknown, signal?: AbortSignal) {
    const i = invocation(p, signal); check(i);
    if (!supportsNativeImageGeneration(i.model)) throw Error(IMAGE_GENERATION_UNSUPPORTED_MESSAGE);
    throw Error("image_generation is a native openai-codex provider tool and should not execute locally");
  } };
}
export function createNativeViewImageTool(p: NativeProviderToolPorts) {
  const original = supportsOriginalImageDetail(p.model);
  return { ...createViewImageTool({ allowOriginalDetail: original }), async execute(id: string, params: unknown, signal?: AbortSignal) {
    const i = invocation(p, signal); check(i);
    if (!i.model.input?.includes("image")) throw Error("view_image is not allowed because you do not support image inputs");
    const parsed = parseViewImageParams(params);
    if (parsed.detail === "original" && !original) throw Error("view_image.detail is not available for the current model");
    const result = await p.readImage({ ...i, path: resolve(i.cwd, parsed.path), original: parsed.detail === "original", toolCallId: id });
    check(i);
    const image = result.content.find(c => c.type === "image");
    if (!image) throw Error("view_image expected an image file. Use exec_command for text files.");
    return { ...result, content: [image] };
  } };
}
