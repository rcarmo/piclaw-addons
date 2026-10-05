import type { Readable, Writable } from 'node:stream';
import { LIMITS, ProxyError } from './contracts.ts';

/** Fixed inherited pipes only. At most two writes (request + cancellation), bounded bytes.
 * A failed/stalled write aborts the whole channel; it never pretends the host settled. */
export function createPipeChannel(input: Readable, output: Writable, handlers: {
  data(bytes: Uint8Array): void;
  lost(error?: ProxyError): void;
}) {
  let closed = false, pendingBytes = 0, pendingCount = 0;
  const pending = new Set<(error: ProxyError) => void>();
  function close(error?: ProxyError) {
    if (closed) return;
    closed = true;
    for (const reject of [...pending]) reject(new ProxyError('REQUEST_FAILED'));
    input.removeListener('data', data);
    input.destroy(); output.destroy(); handlers.lost(error);
  }
  function data(chunk: Buffer) {
    try { handlers.data(chunk); } catch { close(new ProxyError('INVALID_FRAME')); }
  }
  // Keep error listeners until stream destruction completes; delayed EPIPE must be handled.
  const failed = () => close(new ProxyError('REQUEST_FAILED'));
  input.on('error', failed); output.on('error', failed);
  input.on('end', () => close()); input.on('close', () => close()); output.on('close', () => close());
  input.on('data', data);
  return {
    send(bytes: Uint8Array, signal: AbortSignal): Promise<void> {
      if (closed || signal.aborted) return Promise.reject(new ProxyError('CANCELLED'));
      if (bytes.byteLength > LIMITS.frameBytes + 4 || pendingCount >= 2 || pendingBytes + bytes.byteLength > 2 * (LIMITS.frameBytes + 4)) {
        close(new ProxyError('LIMIT')); return Promise.reject(new ProxyError('LIMIT'));
      }
      const frame = Buffer.from(bytes); pendingCount++; pendingBytes += frame.length;
      return new Promise<void>((resolve, reject) => {
        let finished = false;
        function done(error?: Error | null) {
          if (finished) return;
          finished = true; pending.delete(fail); signal.removeEventListener('abort', aborted);
          pendingCount--; pendingBytes -= frame.length;
          if (error) reject(new ProxyError('REQUEST_FAILED')); else resolve();
        }
        const fail = (error: ProxyError) => done(error);
        const aborted = () => close(new ProxyError('CANCELLED'));
        pending.add(fail); signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) { aborted(); return; }
        try { output.write(frame, error => { done(error); if (error) failed(); }); }
        catch { failed(); }
      });
    },
    close,
  };
}
