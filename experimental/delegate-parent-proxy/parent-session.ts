import type { AssistantMessageEvent, Context } from '@earendil-works/pi-ai';
import { LIMITS, ProxyError, type ChildRequestScopeV1, type ChildRequestStreamV1, type ErrorCode, type ServerFrame } from './contracts.ts';
import { encodeFrame, FrameDecoder, requestFrame, type WireStart } from './framing.ts';
import { projectEvent, validateContext } from './validation.ts';

type Outgoing = ServerFrame extends infer F ? F extends ServerFrame ? Omit<F, 'version' | 'id' | 'seq'> : never : never;

export interface ParentSessionOptions {
  scope: ChildRequestScopeV1;
  /** Must resolve only after transport backpressure permits the next frame. */
  send(frame: Uint8Array, signal: AbortSignal): Promise<void>;
  /** Host-owned complete public Context validation; no untrusted casts. */
  validateContext?(context: Context): Context;
  /** Host-owned event projection/validation; strips diagnostics and raw errors. */
  publicEvent?(event: AssistantMessageEvent): AssistantMessageEvent;
}
interface Active {
  id: string;
  seq: number;
  bytes: number;
  count: number;
  controller: AbortController;
  stream?: ChildRequestStreamV1;
  task?: Promise<void>;
  cancelled: boolean;
  terminal: boolean;
}

/** Inactive consumer adapter: no registration, credential lookup, process or provider calls. */
export class ParentProxySession {
  private readonly decoder: FrameDecoder;
  private readonly usedIds = new Set<string>();
  private active?: Active;
  private closed = false;
  private readonly output = new AbortController();
  private closeTask?: Promise<void>;
  private hostClose?: Promise<void>;
  private settlementFailed = false;
  constructor(private readonly options: ParentSessionOptions) {
    const plan = options.scope.plan;
    if (plan.version !== 1 || plan.execution !== 'parent-provider-proxy' || plan.mcp !== 'none'
      || !plan.model.provider || !plan.model.id) throw new ProxyError('UNSUPPORTED_PLAN');
    this.decoder = new FrameDecoder(value => {
      const request = requestFrame(value);
      if (request.type === 'cancel') {
        if (!this.active || this.active.id !== request.id || this.active.cancelled) throw new ProxyError('INVALID_FRAME');
        this.active.cancelled = true;
        this.active.controller.abort(); this.active.stream?.cancel();
        return;
      }
      if (this.active || this.usedIds.has(request.id)) throw new ProxyError('INVALID_FRAME');
      if (this.usedIds.size >= LIMITS.requests) throw new ProxyError('LIMIT');
      this.usedIds.add(request.id);
      const active: Active = { id: request.id, seq: 0, bytes: 0, count: 0, controller: new AbortController(), cancelled: false, terminal: false };
      this.active = active;
      // Admission is synchronous; async context/stream work cannot admit a sibling frame.
      active.task = this.run(active, request);
    });
  }
  push(chunk: Uint8Array): void {
    if (this.closed) throw new ProxyError('INVALID_FRAME');
    try { this.decoder.push(chunk); }
    catch (error) {
      void this.close().catch(() => {}); // close/settlement still observable through close().
      throw error instanceof ProxyError ? error : new ProxyError('INVALID_FRAME');
    }
  }
  async end(): Promise<void> {
    try { this.decoder.end(); }
    catch (error) { await this.close(); throw error; }
    await this.close();
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    // Publish before synchronous abort callbacks can re-enter close().
    this.closeTask = Promise.resolve().then(async () => {
      this.output.abort(); this.active?.controller.abort(); this.active?.stream?.cancel();
      const results = await Promise.allSettled([this.closeHost(), this.active?.task]);
      if (this.settlementFailed || results.some(result => result.status === 'rejected')) throw new ProxyError('SETTLEMENT_FAILED');
    });
    return this.closeTask;
  }
  private closeHost(): Promise<void> {
    if (!this.hostClose) {
      this.hostClose = Promise.resolve().then(() => this.options.scope.close());
      void this.hostClose.catch(() => {});
    }
    return this.hostClose;
  }
  private async send(active: Active, frame: Outgoing): Promise<void> {
    if (this.closed) return;
    const encoded = encodeFrame({ ...frame, version: 1, id: active.id, seq: active.seq++ });
    if (++active.count > LIMITS.events || (active.bytes += encoded.byteLength) > LIMITS.responseBytes) throw new ProxyError('LIMIT');
    const signal = frame.type === 'event'
      ? AbortSignal.any([this.output.signal, active.controller.signal]) : this.output.signal;
    signal.throwIfAborted();
    await this.options.send(encoded, signal);
  }
  private async terminalError(active: Active, code: ErrorCode): Promise<void> {
    if (active.terminal || this.closed) return;
    active.terminal = true;
    await this.send(active, { type: 'error', code });
  }
  private async run(active: Active, request: WireStart): Promise<void> {
    let started = false;
    let settlement: Promise<{ ok: true } | { ok: false }> | undefined;
    try {
      const parsed = validateContext(request.context);
      const context = this.options.validateContext ? validateContext(this.options.validateContext(parsed)) : parsed;
      if (this.closed || active.cancelled) { await this.terminalError(active, 'CANCELLED'); return; }
      const stream = this.options.scope.stream(context, request.options, { requestId: request.id, signal: active.controller.signal });
      active.stream = stream;
      // Observe immediately to prevent an early settlement rejection becoming unhandled.
      settlement = stream.settled.then(() => ({ ok: true as const }), () => ({ ok: false as const }));
      for await (const raw of stream) {
        if (this.closed) break;
        if (active.cancelled) break;
        const event = projectEvent(this.options.publicEvent ? this.options.publicEvent(raw) : raw, this.options.scope.plan);
        if (active.terminal) throw new ProxyError('INVALID_FRAME');
        if (event.type === 'error') {
          // Raw provider errorMessage/diagnostics never cross this boundary.
          await this.terminalError(active, event.reason === 'aborted' ? 'CANCELLED' : 'REQUEST_FAILED');
          continue;
        }
        if (event.type === 'start') {
          if (started) throw new ProxyError('INVALID_FRAME');
          started = true;
        } else if (!started) throw new ProxyError('INVALID_FRAME');
        await this.send(active, { type: 'event', event });
        if (event.type === 'done') active.terminal = true;
      }
      if (active.cancelled) await this.terminalError(active, 'CANCELLED');
      if (!active.terminal && !this.closed) throw new ProxyError('INVALID_FRAME');
    } catch (error) {
      active.controller.abort(); active.stream?.cancel();
      // A second event after a terminal is a broken stream, not successful settlement.
      if (active.terminal) { this.closed = true; this.output.abort(); void this.closeHost(); }
      try { await this.terminalError(active, active.cancelled ? 'CANCELLED' : error instanceof ProxyError ? error.code : 'REQUEST_FAILED'); }
      catch { this.closed = true; this.output.abort(); void this.closeHost(); }
    } finally {
      if (settlement) {
        const result = await settlement;
        if (!result.ok) {
          // No success settlement and no next request after an unaccounted/raw failed tail.
          this.settlementFailed = true;
          this.closed = true; this.output.abort();
          await this.closeHost().catch(() => {});
        }
      }
      if (!this.closed) {
        // Child may synchronously start its next request on receiving this ACK.
        if (this.active === active) this.active = undefined;
        try { await this.send(active, { type: 'settled' }); }
        catch { this.closed = true; this.output.abort(); void this.closeHost(); }
      }
      if (this.active === active) this.active = undefined;
    }
  }
}
