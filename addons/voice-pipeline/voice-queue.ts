/**
 * VoiceQueue — serialises voice requests through the running piclaw agent.
 *
 * Voice transcript → pi.sendUserMessage() → agent_end → response text
 *
 * The extension registers an agent_end listener once and this class
 * resolves the pending promise when the assistant finishes.
 */

export interface VoiceQueueOptions {
  timeoutMs?: number;
}

export class VoiceQueue {
  private _resolver: ((text: string) => void) | null = null;
  private _rejecter: ((err: Error) => void) | null = null;
  private _busy = false;
  private timeoutMs: number;

  constructor(opts: VoiceQueueOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** Register the agent_end handler (call once during session_start) */
  onAgentEnd(messages: Array<{ role: string; content: unknown }>) {
    if (!this._resolver) return;
    // Extract last assistant text
    const last = [...messages].reverse().find(m => m.role === "assistant");
    if (!last) return;
    const content = last.content as Array<{ type: string; text?: string }>;
    const text = Array.isArray(content)
      ? content.filter(c => c.type === "text").map(c => c.text ?? "").join("")
      : String(last.content ?? "");

    const resolve = this._resolver;
    this._resolver = null;
    this._rejecter = null;
    this._busy = false;
    resolve(text.trim());
  }

  /** Send a voice transcript and wait for Flint's response */
  async chat(
    sendMessage: (text: string) => void,
    transcript: string,
  ): Promise<string> {
    if (this._busy) return ""; // drop concurrent requests
    this._busy = true;

    return new Promise((resolve, reject) => {
      this._resolver = resolve;
      this._rejecter = reject;
      sendMessage(transcript);

      const timer = setTimeout(() => {
        if (!this._resolver) return;
        const rejecter = this._rejecter;
        const timeoutMs = this.timeoutMs;
        this._resolver = null;
        this._rejecter = null;
        this._busy = false;
        rejecter?.(new Error(`voice queue timed out after ${timeoutMs}ms`));
      }, this.timeoutMs);

      const clear = () => clearTimeout(timer);

      const prevResolve = this._resolver;
      const prevReject = this._rejecter;
      this._resolver = (text) => {
        clear();
        this._resolver = null;
        this._rejecter = null;
        this._busy = false;
        prevResolve?.(text);
      };
      this._rejecter = (err) => {
        clear();
        this._resolver = null;
        this._rejecter = null;
        this._busy = false;
        prevReject?.(err);
      };
    });
  }

  get busy() { return this._busy; }

  setTimeoutMs(ms: number) {
    this.timeoutMs = ms;
  }
}
