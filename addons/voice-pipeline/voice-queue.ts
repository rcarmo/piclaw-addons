/**
 * VoiceQueue — serialises voice requests through the running piclaw agent.
 *
 *   voice transcript → sendMessage() → agent_end → response text
 *
 * The extension registers a single agent_end listener and this class resolves
 * the pending promise when the assistant finishes. Concurrent requests while a
 * turn is in flight are rejected with a BusyError (surfaced to the device),
 * rather than silently dropped (#15).
 */

export class BusyError extends Error {
  readonly busy = true;
  constructor(message = "voice pipeline is busy with another request") {
    super(message);
    this.name = "BusyError";
  }
}

export interface VoiceQueueOptions {
  timeoutMs?: number;
}

export class VoiceQueue {
  private _resolve: ((text: string) => void) | null = null;
  private _reject: ((err: Error) => void) | null = null;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _busy = false;
  private timeoutMs: number;

  constructor(opts: VoiceQueueOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  private settleReset(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._resolve = null;
    this._reject = null;
    this._busy = false;
  }

  /** Called from the extension's agent_end handler with the finished turn's messages. */
  onAgentEnd(messages: Array<{ role: string; content: unknown }>): void {
    if (!this._resolve) return;
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last) return;
    const content = last.content as Array<{ type: string; text?: string }>;
    const text = Array.isArray(content)
      ? content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
      : String(last.content ?? "");

    const resolve = this._resolve;
    this.settleReset();
    resolve(text.trim());
  }

  /** Send a voice transcript and wait for the assistant's response. */
  chat(sendMessage: (text: string) => void, transcript: string): Promise<string> {
    if (this._busy) return Promise.reject(new BusyError());
    this._busy = true;

    return new Promise<string>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this._timer = setTimeout(() => {
        const rej = this._reject;
        const ms = this.timeoutMs;
        this.settleReset();
        rej?.(new Error(`voice queue timed out after ${ms}ms`));
      }, this.timeoutMs);

      try {
        sendMessage(transcript);
      } catch (err) {
        const rej = this._reject;
        this.settleReset();
        rej?.(err as Error);
      }
    });
  }

  get busy(): boolean {
    return this._busy;
  }

  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }
}
