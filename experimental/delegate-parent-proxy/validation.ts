import type { AssistantMessage, AssistantMessageEvent, Context } from '@earendil-works/pi-ai';
import { LIMITS, ProxyError, type ChildRequestPlanV1 } from './contracts.ts';
import { jsonTree, record } from './framing.ts';

function fail(): never { throw new ProxyError('INVALID_FRAME'); }
const str = (v: unknown): v is string => typeof v === 'string';
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = (v: unknown): v is number => number(v) && Number.isSafeInteger(v);
function optionalString(r: Record<string, unknown>, key: string): void { if (r[key] !== undefined && !str(r[key])) fail(); }
function array(v: unknown, max: number): unknown[] { if (!Array.isArray(v) || v.length > max) return fail(); return v; }
function tool(v: unknown): void {
  const r = record(v, ['name', 'description', 'parameters', 'constrainedSampling']);
  if (!str(r.name) || !r.name || !str(r.description) || !r.parameters || typeof r.parameters !== 'object' || Array.isArray(r.parameters)) fail();
  if (r.constrainedSampling !== undefined && r.constrainedSampling !== false) {
    const sampling = record(r.constrainedSampling, ['type', 'strict', 'variants']);
    if (sampling.type === 'json_schema') {
      record(sampling, ['type', 'strict']); if (!['prefer', 'require'].includes(sampling.strict as string)) fail();
    } else if (sampling.type === 'grammar') {
      record(sampling, ['type', 'variants']); const variants = record(sampling.variants, ['openai_lark', 'openai_regex']);
      if (!Object.keys(variants).length || Object.values(variants).some(v => !str(v) || !v)) fail();
    } else fail();
  }
}
function content(v: unknown, allowed: readonly string[]): void {
  if (!v || typeof v !== 'object') fail();
  const type = (v as Record<string, unknown>).type;
  if (typeof type !== 'string' || !allowed.includes(type)) fail();
  if (type === 'text') {
    const r = record(v, ['type', 'text', 'textSignature']); if (!str(r.text)) fail(); optionalString(r, 'textSignature');
  } else if (type === 'image') {
    const r = record(v, ['type', 'data', 'mimeType']);
    if (!str(r.data) || !str(r.mimeType) || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(r.mimeType)) fail();
  } else if (type === 'thinking') {
    const r = record(v, ['type', 'thinking', 'thinkingSignature', 'redacted']);
    if (!str(r.thinking) || (r.redacted !== undefined && typeof r.redacted !== 'boolean')) fail(); optionalString(r, 'thinkingSignature');
  } else {
    const r = record(v, ['type', 'id', 'name', 'arguments', 'thoughtSignature', 'namespace']);
    if (!str(r.id) || !r.id || !str(r.name) || !r.name || !r.arguments || typeof r.arguments !== 'object' || Array.isArray(r.arguments)) fail();
    optionalString(r, 'thoughtSignature'); optionalString(r, 'namespace');
  }
}
function usage(v: unknown): void {
  const r = record(v, ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'totalTokens', 'cost']);
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) if (!integer(r[k])) fail();
  for (const k of ['cacheWrite1h', 'reasoning']) if (r[k] !== undefined && !integer(r[k])) fail();
  const costs = record(r.cost, ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'total']);
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) if (!number(costs[k])) fail();
  for (const k of ['cacheWrite1h', 'reasoning']) if (costs[k] !== undefined && !number(costs[k])) fail();
}
const assistantFields = ['role', 'content', 'api', 'provider', 'model', 'usage', 'stopReason', 'timestamp', 'responseId', 'responseModel', 'providerThinkingLevel', 'thinkingLevel', 'endTurn'] as const;
function assistant(v: unknown): void {
  const r = record(v, assistantFields);
  if (r.role !== 'assistant' || !str(r.api) || !str(r.provider) || !str(r.model) || !number(r.timestamp)) fail();
  if (!['pending', 'stop', 'length', 'toolUse', 'error', 'aborted'].includes(r.stopReason as string)) fail();
  for (const item of array(r.content, 4096)) content(item, ['text', 'thinking', 'toolCall']);
  usage(r.usage);
  for (const key of ['responseId', 'responseModel', 'providerThinkingLevel']) optionalString(r, key);
  if (r.thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(r.thinkingLevel as string)) fail();
  if (r.endTurn !== undefined && typeof r.endTurn !== 'boolean') fail();
}
/** Strict public Pi 1.0.1 context subset. Provider/tool/account authority is not inferred from history. */
export function validateContext(value: unknown): Context {
  jsonTree(value);
  const r = record(value, ['messages', 'systemPrompt', 'tools']); optionalString(r, 'systemPrompt');
  if (r.tools !== undefined) for (const item of array(r.tools, 256)) tool(item);
  for (const value of array(r.messages, 4096)) {
    if (!value || typeof value !== 'object') fail();
    switch ((value as Record<string, unknown>).role) {
      case 'system': {
        const m = record(value, ['role', 'content', 'sections', 'toolsAdded', 'toolsRemoved', 'timestamp']);
        if (!number(m.timestamp)) fail();
        if (!str(m.content)) for (const block of array(m.content, 4096)) content(block, ['text']);
        if (m.sections !== undefined) {
          if (!m.sections || typeof m.sections !== 'object' || Array.isArray(m.sections)) fail();
          if (Object.values(m.sections).some(x => x !== null && !str(x))) fail();
        }
        if (m.toolsAdded !== undefined) for (const item of array(m.toolsAdded, 256)) tool(item);
        if (m.toolsRemoved !== undefined) for (const item of array(m.toolsRemoved, 256)) { const t = record(item, ['name']); if (!str(t.name)) fail(); }
        break;
      }
      case 'user': {
        const m = record(value, ['role', 'content', 'timestamp']); if (!number(m.timestamp)) fail();
        if (!str(m.content)) for (const item of array(m.content, 4096)) content(item, ['text', 'image']);
        break;
      }
      case 'assistant': assistant(value); break;
      case 'toolResult': {
        // Arbitrary details/nested billing metadata are deliberately excluded from provider context.
        const m = record(value, ['role', 'toolCallId', 'toolName', 'content', 'isError', 'timestamp']);
        if (!str(m.toolCallId) || !str(m.toolName) || !number(m.timestamp) || typeof m.isError !== 'boolean') fail();
        for (const item of array(m.content, 4096)) content(item, ['text', 'image']);
        break;
      }
      default: fail();
    }
  }
  return structuredClone(r) as unknown as Context;
}
function publicMessage(value: AssistantMessage, plan: ChildRequestPlanV1): AssistantMessage {
  if (!value || typeof value !== 'object') fail();
  // Copy only the qualified public message surface; drop provider diagnostics and errorMessage.
  const result: Record<string, unknown> = {};
  for (const key of assistantFields) if (value[key] !== undefined) result[key] = value[key];
  assistant(result); jsonTree(result);
  if (result.provider !== plan.model.provider || result.model !== plan.model.id
    || (result.responseModel !== undefined && result.responseModel !== plan.model.id && result.responseModel !== `${plan.model.provider}/${plan.model.id}`)) throw new ProxyError('REQUEST_FAILED');
  return structuredClone(result) as unknown as AssistantMessage;
}
/** Defense-in-depth projection; host still sanitizes diagnostic/error text before this adapter. */
export function projectEvent(raw: AssistantMessageEvent, plan: ChildRequestPlanV1): AssistantMessageEvent {
  if (!raw || typeof raw !== 'object') fail();
  if (raw.type === 'error') {
    if (raw.reason !== 'aborted' && raw.reason !== 'error') fail();
    // Parent-session sends only the reason's finite machine code, never this object.
    return { type: 'error', reason: raw.reason, error: { role: 'assistant', content: [], api: 'proxy', provider: plan.model.provider, model: plan.model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: raw.reason, timestamp: 0 } };
  }
  if (raw.type === 'done') {
    if (!['stop', 'length', 'toolUse'].includes(raw.reason)) throw new ProxyError('REQUEST_FAILED');
    const message = publicMessage(raw.message, plan);
    if (message.stopReason !== raw.reason) fail();
    return { type: 'done', reason: raw.reason, message };
  }
  const partial = publicMessage(raw.partial, plan);
  if (raw.type === 'start') return { type: 'start', partial };
  if (!['text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end'].includes(raw.type)) fail();
  if (!integer(raw.contentIndex) || raw.contentIndex >= 4096) fail();
  const event: Record<string, unknown> = { type: raw.type, contentIndex: raw.contentIndex, partial };
  if ('delta' in raw) { if (!str(raw.delta)) fail(); event.delta = raw.delta; }
  if ('content' in raw) { if (!str(raw.content)) fail(); event.content = raw.content; }
  if ('toolCall' in raw) { content(raw.toolCall, ['toolCall']); event.toolCall = raw.toolCall; }
  if (raw.type.endsWith('_delta') && !('delta' in event)) fail();
  if (['text_end', 'thinking_end'].includes(raw.type) && !('content' in event)) fail();
  if (raw.type === 'toolcall_end' && !('toolCall' in event)) fail();
  jsonTree(event);
  if (Buffer.byteLength(JSON.stringify(event)) > LIMITS.frameBytes) throw new ProxyError('LIMIT');
  return structuredClone(event) as unknown as AssistantMessageEvent;
}
