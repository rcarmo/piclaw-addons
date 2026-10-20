/** Native host contract. No ExtensionAPI, AgentSession or ambient invocation state. */
import { createNativeCodexHooks, type NativeModelDescriptor } from './native.ts';
import { restoreTools } from './adapter/tool-set.ts';
export interface CodexModel extends NativeModelDescriptor { provider: string; id: string; api: string }
export interface CodexOperation {
  readonly id: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: CodexModel;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface CodexProfilePort {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}
export function createNativeCodexProfile(port: CodexProfilePort) {
  let previous: string[] | undefined;
  return {
    modelSelect(model: CodexModel) {
      const hooks = createNativeCodexHooks(model);
      const active = port.getActiveTools();
      if (hooks.profile !== 'native') {
        previous ??= [...active];
        port.setActiveTools(hooks.tools(active));
      } else if (previous) {
        port.setActiveTools(restoreTools(previous, active));
        previous = undefined;
      }
      return hooks;
    },
    operation(operation: CodexOperation) {
      const model = Object.freeze({ ...operation.model, input: operation.model.input && [...operation.model.input] });
      const hooks = createNativeCodexHooks(model);
      const check = (actual: CodexModel = model) => {
        operation.signal.throwIfAborted();
        operation.assertCurrent();
        if (actual.provider !== model.provider || actual.id !== model.id || actual.api !== model.api)
          throw new Error('Codex operation model changed');
      };
      return Object.freeze({ operation, model, hooks, check });
    },
  };
}
export interface NativeCodexBinding<Provider> {
  readonly providerId: 'openai-codex';
  readonly api: 'openai-codex-responses';
  /** A concrete provider object, not a deferred registration record. */
  readonly provider: Provider;
  check(): void;
  dispose(): Promise<void>;
}
/** Install immediately into the exact mutable Models used for dispatch. */
export function bindNativeCodexProvider<P extends { id: string }>(
  models: { setProvider(provider: P): void; getProvider(id: string): P | undefined },
  provider: P,
  dispose: () => Promise<void>,
): NativeCodexBinding<P> {
  if (provider.id !== 'openai-codex') throw new Error('Wrong Codex provider owner');
  models.setProvider(provider);
  const check = () => {
    if (models.getProvider('openai-codex') !== provider) throw new Error('Codex provider override is not bound');
  };
  check();
  return Object.freeze({ providerId: 'openai-codex', api: 'openai-codex-responses', provider, check, dispose });
}

/** Per-operation capture: host must await finish before accounting/lifetime release. */
export async function createNativeCodexOutput(operation: CodexOperation, publish: (
  operation: CodexOperation,
  activity: import('./providers/openai-codex-native-output-observer.ts').PendingActivity,
) => Promise<void>) {
  const { captureNativeOutputResponse } = await import('./providers/openai-codex-native-output-observer.ts');
  const beforeEffect = () => { operation.signal.throwIfAborted(); operation.assertCurrent(); };
  const pending: import('./providers/openai-codex-native-output-observer.ts').PendingActivity[] = [];
  let tail = Promise.resolve();
  let closed = false;
  return {
    capture(response: Response, prompt?: string) {
      if (closed) throw new Error('Codex capture closed');
      operation.signal.throwIfAborted(); operation.assertCurrent();
      const clone = response.clone();
      tail = tail.then(() => captureNativeOutputResponse(clone, operation.cwd, prompt, activity => { beforeEffect(); pending.push(activity); }, beforeEffect));
      return tail;
    },
    async finish() {
      closed = true;
      await tail;
      beforeEffect();
      while (pending.length) {
        beforeEffect();
        await publish(operation, pending[0]!);
        beforeEffect();
        pending.shift();
      }
    },
  };
}
