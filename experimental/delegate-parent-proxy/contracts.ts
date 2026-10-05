import type { AssistantMessageEvent, Context, ThinkingLevel } from '@earendil-works/pi-ai';

// Structural copy of proposed PUBLIC core contract, not a runtime/private-source import.
// SHA c8ebf5520c122d5d7ba263b852436c6b2c0a10f0fe13e3973977abcf64e236ea.
export interface ChildRequestOptionsV1 { temperature?: number; maxTokens?: number; reasoning?: ThinkingLevel; }
export interface ChildRequestPlanV1 { version: 1; execution: 'parent-provider-proxy'; model: { provider: string; id: string }; mcp: 'none'; }
export interface ChildRequestStreamV1 extends AsyncIterable<AssistantMessageEvent> {
  settled: Promise<void>;
  cancel(): void;
}
export interface ChildRequestScopeV1 {
  readonly plan: Readonly<ChildRequestPlanV1>;
  stream(context: Context, options: ChildRequestOptionsV1, request: { requestId: string; signal?: AbortSignal }): ChildRequestStreamV1;
  close(): Promise<void>;
}
export type ErrorCode = 'INVALID_FRAME' | 'LIMIT' | 'REQUEST_FAILED' | 'CANCELLED' | 'SETTLEMENT_FAILED' | 'UNSUPPORTED_PLAN';
export class ProxyError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'ProxyError'; }
}
export const LIMITS = Object.freeze({ frameBytes: 4 * 1024 * 1024, responseBytes: 16 * 1024 * 1024, events: 8192, depth: 32, requests: 64 });
export type ClientFrame =
  | { version: 1; type: 'start'; id: string; context: Context; options: ChildRequestOptionsV1 }
  | { version: 1; type: 'cancel'; id: string };
export type ServerFrame =
  | { version: 1; type: 'event'; id: string; seq: number; event: AssistantMessageEvent }
  | { version: 1; type: 'error'; id: string; seq: number; code: ErrorCode }
  | { version: 1; type: 'settled'; id: string; seq: number };
