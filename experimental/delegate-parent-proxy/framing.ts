import { LIMITS, ProxyError, type ChildRequestOptionsV1 } from './contracts.ts';

export interface WireStart { version: 1; type: 'start'; id: string; context: unknown; options: ChildRequestOptionsV1; }
export interface WireCancel { version: 1; type: 'cancel'; id: string; }
export type WireRequest = WireStart | WireCancel;

export function jsonTree(value: unknown): void {
  let nodes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (depth > LIMITS.depth || ++nodes > 100_000) throw new ProxyError('LIMIT');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new ProxyError('INVALID_FRAME'); return; }
    if (!v || typeof v !== 'object') throw new ProxyError('INVALID_FRAME');
    if (Array.isArray(v)) { for (const item of v) visit(item, depth + 1); return; }
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new ProxyError('INVALID_FRAME');
    for (const [key, item] of Object.entries(v)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new ProxyError('INVALID_FRAME');
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}
export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new ProxyError('INVALID_FRAME');
  return value as Record<string, unknown>;
}
export function requestFrame(value: unknown): WireRequest {
  jsonTree(value);
  const r = record(value, ['version', 'type', 'id', 'context', 'options']);
  if (r.version !== 1 || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id)) throw new ProxyError('INVALID_FRAME');
  if (r.type === 'cancel') {
    record(r, ['version', 'type', 'id']);
    return { version: 1, type: 'cancel', id: r.id };
  }
  if (r.type !== 'start') throw new ProxyError('INVALID_FRAME');
  const context = record(r.context, ['messages', 'systemPrompt', 'tools']);
  if (!Array.isArray(context.messages) || context.messages.length > 4096
    || (context.systemPrompt !== undefined && typeof context.systemPrompt !== 'string')
    || (context.tools !== undefined && (!Array.isArray(context.tools) || context.tools.length > 256))) throw new ProxyError('INVALID_FRAME');
  const options = record(r.options, ['temperature', 'maxTokens', 'reasoning']);
  if (options.temperature !== undefined && (typeof options.temperature !== 'number' || options.temperature < 0 || options.temperature > 2)) throw new ProxyError('INVALID_FRAME');
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || (options.maxTokens as number) < 1 || (options.maxTokens as number) > 1_000_000)) throw new ProxyError('INVALID_FRAME');
  if (options.reasoning !== undefined && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(options.reasoning as string)) throw new ProxyError('INVALID_FRAME');
  // Nested public Context validation and model-specific option caps belong to the supplied host adapter.
  return { version: 1, type: 'start', id: r.id, context, options: options as ChildRequestOptionsV1 };
}
export function encodeFrame(value: unknown): Buffer {
  jsonTree(value);
  const body = Buffer.from(JSON.stringify(value));
  if (body.byteLength === 0 || body.byteLength > LIMITS.frameBytes) throw new ProxyError('LIMIT');
  const frame = Buffer.allocUnsafe(body.byteLength + 4);
  frame.writeUInt32BE(body.byteLength); body.copy(frame, 4);
  return frame;
}

/** Incremental 4-byte BE framing. At most one 4MiB body and a 4-byte header retained. */
export class FrameDecoder {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private body?: Buffer;
  private bodyBytes = 0;
  private failed = false;
  constructor(private readonly onFrame: (value: unknown) => void) {}
  push(chunk: Uint8Array): void {
    if (this.failed) throw new ProxyError('INVALID_FRAME');
    try {
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (!this.body) {
          const n = Math.min(4 - this.headerBytes, chunk.byteLength - offset);
          this.header.set(chunk.subarray(offset, offset + n), this.headerBytes);
          offset += n; this.headerBytes += n;
          if (this.headerBytes < 4) continue;
          const size = this.header.readUInt32BE();
          if (!size || size > LIMITS.frameBytes) throw new ProxyError('LIMIT');
          this.body = Buffer.allocUnsafe(size); this.bodyBytes = 0;
        }
        const n = Math.min(this.body.length - this.bodyBytes, chunk.byteLength - offset);
        this.body.set(chunk.subarray(offset, offset + n), this.bodyBytes);
        this.bodyBytes += n; offset += n;
        if (this.bodyBytes === this.body.length) {
          const body = this.body;
          this.body = undefined; this.bodyBytes = 0; this.headerBytes = 0;
          let parsed: unknown;
          try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
          catch { throw new ProxyError('INVALID_FRAME'); }
          jsonTree(parsed); this.onFrame(parsed);
        }
      }
    } catch (e) {
      this.failed = true; this.body = undefined; this.bodyBytes = this.headerBytes = 0;
      throw e instanceof ProxyError ? e : new ProxyError('INVALID_FRAME');
    }
  }
  end(): void {
    if (this.failed || this.headerBytes || this.body) throw new ProxyError('INVALID_FRAME');
    this.failed = true;
  }
}
