/** Native entry: factories only; importing does not register, authenticate or start processes. */
import { createViewImageParameters } from "./tools/view-image-tool.ts";
import { resolveAdapterProfile, applyGitHubCopilotInferenceProfile } from "./adapter/provider-profile.ts";
import { mergeAdapterTools } from "./adapter/tool-set.ts";
import { buildCodexSystemPrompt, extractPiPromptSkills } from "./prompt/build-system-prompt.ts";
import { rewriteNativeImageGenerationTool, rewriteNativeWebSearchTool, supportsOriginalImageDetail, type NativeModelDescriptor } from "./native-request.ts";
export { rewriteNativeImageGenerationTool, rewriteNativeWebSearchTool } from "./native-request.ts";
export { resolveAdapterProfile } from "./adapter/provider-profile.ts";
export type { NativeModelDescriptor } from "./native-request.ts";

const activityTypes = new Set(["codex-web-search-session-note", "codex-web-search-activity", "codex-image-generation-display"]);
export function createNativeCodexHooks(model: NativeModelDescriptor | undefined) {
  // Detach from caller mutation; hooks carry only immutable invocation-independent data.
  const snapshot = model && Object.freeze({ ...model, input: model.input && Object.freeze([...model.input]) });
  const profile = resolveAdapterProfile(snapshot);
  return Object.freeze({
    profile,
    tools(active: string[]) {
      if (profile === "native") return active.filter(name => name !== "view_image" || snapshot?.input?.includes("image"));
      return mergeAdapterTools(active, ["exec_command", "write_stdin", "apply_patch", ...(snapshot?.input?.includes("image") ? ["view_image"] : [])]);
    },
    toolDeclarations<T extends { name: string }>(tools: readonly T[]): T[] {
      return tools.map(tool => tool.name === "view_image"
        ? { ...tool, parameters: createViewImageParameters(supportsOriginalImageDetail(snapshot)) } : tool);
    },
    headers(headers: Parameters<typeof applyGitHubCopilotInferenceProfile>[0]) {
      const next = { ...headers };
      applyGitHubCopilotInferenceProfile(next, snapshot as Parameters<typeof applyGitHubCopilotInferenceProfile>[1]);
      return next;
    },
    request(payload: unknown) {
      return rewriteNativeImageGenerationTool(rewriteNativeWebSearchTool(payload, snapshot), snapshot);
    },
    context<T extends { role: string; customType?: string }>(messages: readonly T[]): T[] {
      return messages.filter(message => message.role !== "custom" || !activityTypes.has(message.customType ?? ""));
    },
    systemPrompt(prompt: string, shell?: string) {
      return profile === "native" ? prompt : buildCodexSystemPrompt(prompt, { skills: extractPiPromptSkills(prompt), shell });
    },
  });
}

// Concrete factories do not register tools or start processes during import.
export { createNativeProcessPool, createNativeExecCommandTool, createNativeWriteStdinTool } from "./native-process.ts";
export type { ProcessIdentity, ProcessInvocation, NativeProcessPool } from "./native-process.ts";
export { createNativeApplyPatchFactory } from "./native-patch.ts";
export type { NativePatchAuthority } from "./native-patch.ts";
export type { PatchFilePorts } from "./patch/paths.ts";
export { createNativeWebSearchTool, createNativeImageGenerationTool, createNativeViewImageTool } from "./native-provider-tools.ts";
export type { NativeProviderResult, NativeProviderInvocation, NativeProviderToolPorts } from "./native-provider-tools.ts";
export { createNativeCodexProfile, bindNativeCodexProvider, createNativeCodexOutput } from "./native-provider.ts";
export type { CodexModel, CodexOperation, CodexProfilePort, NativeCodexBinding } from "./native-provider.ts";
