import type { AssistantMessage, AssistantMessageEventStream, Context, Model, Provider, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import { ChildProxySession } from './child-session.ts';
import { ProxyError, type ChildRequestPlanV1 } from './contracts.ts';
import { validateContext } from './validation.ts';

/** Project only transcript data. SDK tool-result details and nested charges stay local. */
export function projectProviderContext(context: TranscriptContext): Context {
  const messages = context.messages.map(message => {
    if (message.role === 'toolResult') {
      const { role, toolCallId, toolName, content, isError, timestamp } = message;
      return { role, toolCallId, toolName, content, isError, timestamp };
    }
    if (message.role === 'assistant') {
      const publicMessage = { ...message } as Record<string, unknown>;
      delete publicMessage.errorMessage; delete publicMessage.providerDiagnostics;
      return publicMessage;
    }
    return message;
  });
  // Unsupported SDK blocks/options fail explicitly; never cast arbitrary JSON to TranscriptContext.
  return validateContext({ messages });
}

/** Select the supported request semantics at the trusted child agent boundary.
 * AgentSession passes local callbacks/bookkeeping in its options object. They stay
 * local and are never serialized as provider authority or advertised as HTTP hooks. */
export function childAgentOptions(options: SimpleStreamOptions = {}): SimpleStreamOptions {
  if (options.apiKey || options.env && Object.keys(options.env).length || options.headers && Object.keys(options.headers).length
    || options.fetch || options.samplingParams || options.deferred || options.thinkingBudgets
    || options.cacheRetention !== undefined && options.cacheRetention !== 'none'
    || options.toolChoice && options.toolChoice !== 'auto') throw new ProxyError('UNSUPPORTED_PLAN');
  return { ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}), maxRetries: 0 };
}

/** Credential-free public Provider, with the public SDK event-stream factory injected.
 * This avoids importing another SDK copy. Model metadata comes from the trusted launcher. */
export function createProxyProvider(input: {
  session: ChildProxySession;
  plan: ChildRequestPlanV1;
  model: Model<any>;
  createStream: () => AssistantMessageEventStream;
}) {
  const model = structuredClone(input.model), plan = structuredClone(input.plan);
  if (model.provider !== plan.model.provider || model.id !== plan.model.id || plan.mcp !== 'none') throw new ProxyError('UNSUPPORTED_PLAN');
  if (model.headers || model.baseUrl && model.baseUrl !== 'https://delegate.invalid') throw new ProxyError('UNSUPPORTED_PLAN');
  const tasks = new Set<Promise<void>>();
  let closed = false, active = false, closeTask: Promise<void> | undefined;
  function stream(selected: Model<any>, context: TranscriptContext, options: SimpleStreamOptions = {}): AssistantMessageEventStream {
    if (closed || active || selected.provider !== model.provider || selected.id !== model.id || selected.api !== model.api) throw new ProxyError('UNSUPPORTED_PLAN');
    // SDK default retry/timeout bookkeeping is local. Authority and unsupported semantics are denied.
    for (const key of Object.keys(options)) {
      if ((options as Record<string, unknown>)[key] !== undefined && !['signal', 'temperature', 'maxTokens', 'reasoning', 'maxRetries', 'timeoutMs', 'cacheRetention'].includes(key)) throw new ProxyError('UNSUPPORTED_PLAN');
    }
    if (options.maxRetries !== undefined && options.maxRetries !== 0
      || options.cacheRetention !== undefined && options.cacheRetention !== 'none'
      || options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 300000)) throw new ProxyError('UNSUPPORTED_PLAN');
    options.signal?.throwIfAborted();
    const projected = projectProviderContext(context);
    const request = { ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}) };
    const output = input.createStream();
    const wire = input.session.stream(projected, request);
    active = true;
    let timedOut = false, cancelDelivery!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { cancelDelivery = () => reject(new ProxyError('CANCELLED')); });
    void cancelled.catch(() => {});
    const cancel = () => { wire.cancel(); cancelDelivery(); };
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; cancel(); }, options.timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const task = Promise.resolve().then(async () => {
      let terminal: Extract<Parameters<typeof output.push>[0], { type: 'done' }> | undefined;
      try {
        for await (const event of wire) {
          if (event.type === 'done') terminal = event;
          else output.push(event);
        }
        // Race delivery only. The task below still owns and awaits wire.settled.
        await Promise.race([wire.settled, cancelled]);
        if (!terminal || closed || timedOut || options.signal?.aborted) throw new ProxyError('CANCELLED');
        // Do not release Pi's next turn/tool execution before the parent's raw/accounting ACK.
        output.push(terminal);
      } catch {
        wire.cancel();
        const reason = closed || timedOut || options.signal?.aborted ? 'aborted' : 'error';
        const error: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          stopReason: reason, timestamp: 0, errorMessage: reason === 'aborted' ? 'Delegate cancelled' : 'Delegate proxy failed',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        // This zero-valued transport error is never authoritative host billing.
        output.push({ type: 'error', reason, error });
        await wire.settled.catch(() => {});
      } finally {
        clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
        active = false; output.end();
      }
    });
    tasks.add(task); void task.then(() => tasks.delete(task), () => { closed = true; input.session.close('REQUEST_FAILED'); tasks.delete(task); });
    return output;
  }
  const provider: Provider = {
    id: model.provider, name: 'Parent request proxy',
    // Local no-auth marker only: no credential read/refresh or ambient fallback.
    auth: { apiKey: { name: 'Parent-owned request', async resolve() { return { auth: {} }; } } },
    getModels: () => [structuredClone(model)],
    stream() { throw new ProxyError('UNSUPPORTED_PLAN'); },
    streamSimple: stream,
  };
  return { provider, close(): Promise<void> {
    if (!closeTask) {
      closed = true;
      closeTask = Promise.resolve().then(async () => { input.session.close(); await Promise.all([...tasks]); });
    }
    return closeTask;
  } };
}
