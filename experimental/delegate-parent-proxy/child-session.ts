import type { AssistantMessageEvent, Context } from '@earendil-works/pi-ai';
import { LIMITS, ProxyError, type ChildRequestOptionsV1, type ChildRequestPlanV1, type ErrorCode } from './contracts.ts';
import { encodeFrame, FrameDecoder, record, requestFrame } from './framing.ts';
import { projectEvent } from './validation.ts';

const ERROR_CODES: readonly ErrorCode[] = ['INVALID_FRAME', 'LIMIT', 'REQUEST_FAILED', 'CANCELLED', 'SETTLEMENT_FAILED', 'UNSUPPORTED_PLAN'];
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Stream settlement may precede the consumer asking for it; keep failure observed.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
interface Queued { event: AssistantMessageEvent; bytes: number; }
/** Public-event stream for the child provider adapter; no SDK/provider registration here. */
export interface ProxyChildStream extends AsyncIterable<AssistantMessageEvent> {
  readonly settled: Promise<void>;
  cancel(): void;
}
interface Active {
  id: string; seq: number; receivedBytes: number; count: number; pendingBytes: number;
  events: Queued[]; wake?: () => void; error?: ProxyError; terminal: boolean; started: boolean;
  cancelled: boolean; iteratorClaimed: boolean; consumed: boolean; hostSettled: boolean; settlement: ReturnType<typeof deferred>;
}
export interface ChildSessionOptions {
  plan: ChildRequestPlanV1;
  /** Fixed private channel, never stdout; caller must implement bounded backpressure. */
  send(frame: Uint8Array, signal: AbortSignal): Promise<void>;
  disconnect(): void;
}

export class ChildProxySession {
  private active?: Active;
  private closed = false;
  private nextId = 0;
  private readonly output = new AbortController();
  private readonly decoder: FrameDecoder;
  constructor(private readonly options: ChildSessionOptions) {
    if (options.plan.version !== 1 || options.plan.execution !== 'parent-provider-proxy' || options.plan.mcp !== 'none'
      || !options.plan.model.provider || !options.plan.model.id) throw new ProxyError('UNSUPPORTED_PLAN');
    this.decoder = new FrameDecoder(value => this.receive(value));
  }
  stream(context: Context, options: ChildRequestOptionsV1 = {}): ProxyChildStream {
    if (this.closed || this.active) throw new ProxyError('INVALID_FRAME');
    if (this.nextId >= LIMITS.requests) throw new ProxyError('LIMIT');
    const id = `request_${++this.nextId}`;
    const frame = requestFrame({ version: 1, type: 'start', id, context, options });
    const bytes = encodeFrame(frame);
    const active: Active = { id, seq: 0, receivedBytes: 0, count: 0, pendingBytes: 0, events: [], terminal: false,
      started: false, cancelled: false, iteratorClaimed: false, consumed: false, hostSettled: false, settlement: deferred() };
    this.active = active;
    try {
      void this.options.send(bytes, this.output.signal).catch(() => this.close('REQUEST_FAILED'));
    } catch { this.close('REQUEST_FAILED'); }
    const owner = this;
    return {
      settled: active.settlement.promise,
      cancel() { owner.cancel(active); },
      async *[Symbol.asyncIterator]() {
        if (active.iteratorClaimed) throw new ProxyError('INVALID_FRAME');
        active.iteratorClaimed = true;
        try {
          while (true) {
            if (active.error) throw active.error;
            const queued = active.events.shift();
            if (queued) { active.pendingBytes -= queued.bytes; yield queued.event; continue; }
            if (active.terminal) return;
            await new Promise<void>(resolve => { active.wake = resolve; });
          }
        } finally {
          active.consumed = true; active.events = []; active.pendingBytes = 0;
          if (!active.terminal) owner.cancel(active);
          owner.release(active);
        }
      },
    };
  }
  push(bytes: Uint8Array): void {
    if (this.closed) throw new ProxyError('INVALID_FRAME');
    try { this.decoder.push(bytes); }
    catch (e) { const code = e instanceof ProxyError ? e.code : 'INVALID_FRAME'; this.close(code); throw new ProxyError(code); }
  }
  end(): void {
    try { this.decoder.end(); } finally { this.close('REQUEST_FAILED'); }
  }
  close(code: ErrorCode = 'CANCELLED'): void {
    if (this.closed) return;
    this.closed = true; this.output.abort();
    if (this.active) {
      this.active.error = new ProxyError(code); this.active.events = []; this.active.pendingBytes = 0;
      this.active.settlement.reject(new ProxyError(code)); this.active.wake?.(); this.active.wake = undefined;
    }
    this.options.disconnect();
  }
  private release(active: Active): void {
    if (this.active === active && active.hostSettled && (active.consumed || active.cancelled)) this.active = undefined;
  }
  private cancel(active: Active): void {
    if (this.closed || this.active !== active || active.cancelled) return;
    active.cancelled = true; active.error = new ProxyError('CANCELLED'); active.events = []; active.pendingBytes = 0;
    if (active.hostSettled) { this.release(active); return; }
    active.wake?.(); active.wake = undefined;
    try { void this.options.send(encodeFrame({ version: 1, type: 'cancel', id: active.id }), this.output.signal).catch(() => this.close('REQUEST_FAILED')); }
    catch { this.close('REQUEST_FAILED'); }
    // Deliberately leave settlement pending until the parent's acknowledgement or channel loss.
  }
  private receive(value: unknown): void {
    const frame = record(value, ['version', 'type', 'id', 'seq', 'event', 'code']);
    const active = this.active;
    if (!active || frame.version !== 1 || frame.id !== active.id || !Number.isSafeInteger(frame.seq) || frame.seq !== active.seq++) throw new ProxyError('INVALID_FRAME');
    const size = encodeFrame(value).byteLength;
    if (++active.count > LIMITS.events || (active.receivedBytes += size) > LIMITS.responseBytes) throw new ProxyError('LIMIT');
    if (frame.type === 'settled') {
      record(frame, ['version', 'type', 'id', 'seq']);
      if (!active.terminal) throw new ProxyError('INVALID_FRAME');
      active.hostSettled = true; active.settlement.resolve(); this.release(active); return;
    }
    if (active.terminal) throw new ProxyError('INVALID_FRAME');
    if (frame.type === 'error') {
      record(frame, ['version', 'type', 'id', 'seq', 'code']);
      if (!ERROR_CODES.includes(frame.code as ErrorCode)) throw new ProxyError('INVALID_FRAME');
      active.error = new ProxyError(frame.code as ErrorCode); active.terminal = true;
      active.events = []; active.pendingBytes = 0; active.wake?.(); active.wake = undefined; return;
    }
    if (frame.type !== 'event') throw new ProxyError('INVALID_FRAME');
    record(frame, ['version', 'type', 'id', 'seq', 'event']);
    const event = projectEvent(frame.event as AssistantMessageEvent, this.options.plan);
    // Wire input must already be sanitized; projection must not hide unknown authority/diagnostic keys.
    if (JSON.stringify(frame.event) !== JSON.stringify(event)) {
      const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
      if (JSON.stringify(canonical(frame.event)) !== JSON.stringify(canonical(event))) throw new ProxyError('INVALID_FRAME');
    }
    if (event.type === 'error') throw new ProxyError('INVALID_FRAME'); // error packets carry codes only
    if (event.type === 'start') { if (active.started) throw new ProxyError('INVALID_FRAME'); active.started = true; }
    else if (!active.started) throw new ProxyError('INVALID_FRAME');
    if (event.type === 'done') active.terminal = true;
    if (!active.cancelled) {
      if (active.pendingBytes + size > LIMITS.frameBytes + 4) throw new ProxyError('LIMIT');
      active.pendingBytes += size; active.events.push({ event, bytes: size });
    }
    active.wake?.(); active.wake = undefined;
  }
}
