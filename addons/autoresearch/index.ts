/**
 * piclaw-addon-autoresearch — Autonomous experiment loop sub-agent.
 *
 * Provides start_autoresearch, stop_autoresearch, and autoresearch_status tools.
 */
export { autoresearchSupervisor as default } from "./supervisor.js";
import { autoresearchPrompt } from "./supervisor.js";

export { autoresearchSupervisor, bindNativeAutoresearchObserver, createAutoresearchToolDefinitions } from "./supervisor.js";
export function getAutoresearchPrompt(): string { return autoresearchPrompt; }
export type { NativeAutoresearchInvocation } from "./supervisor.js";
