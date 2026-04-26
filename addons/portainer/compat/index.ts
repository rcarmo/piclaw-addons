/**
 * compat/index.ts — Shared compatibility layer for standalone piclaw addons.
 *
 * Re-exports all shims so addon code can import from one place:
 *   import { getChatJid, createLogger, ... } from "../compat/index.js";
 */

export { getChatJid, getChatChannel, withChatContext } from "./chat-context.js";
export { WORKSPACE_DIR } from "./config.js";
export { getKeychainEntry, listKeychainEntries, resolveKeychainPlaceholders, buildInjectedExecCommand } from "./keychain.js";
export { createLogger, debugSuppressedError, type Logger } from "./logger.js";
export { presentStructuredToolValue, type StructuredToolResponsePresentation } from "./structured-tool-response.js";
export { registerToolStatusHintProvider, resolveToolStatusHints, type ToolStatusHint, type ToolStatusHintContext, type ToolStatusHintProvider } from "./tool-status-hints.js";
export { saveToolOutput, buildPreview, type SavedToolOutput } from "./tool-output.js";
export { runRequestBatch, writeRequestOutputFile, appendOutputFileNote } from "./request-batch.js";
export type { BatchedRequestItem, RequestBatchControls, RequestBatchResult, RequestBatchEntryResult, RequestOutputFileRecord, RequestOutputFormat } from "./request-batch.js";
export type {
  ProxmoxConfig, ProxmoxConfigSetResult, ProxmoxConfigClearResult,
  PortainerConfig, PortainerConfigSetResult, PortainerConfigClearResult,
} from "./types.js";
export { createExtensionStorage, type ExtensionStorage, type KvScope } from "./extension-kv.js";
