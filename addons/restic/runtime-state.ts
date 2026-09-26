import type { ResticService } from './service.ts';

// Startup runtime and chat extensions may use different module loaders. Share the
// process-owned service without starting a second scheduler for each chat.
const KEY = Symbol.for('piclaw.restic.runtime.v1');
export function resticRuntime(): { service?: ResticService } {
  const root = globalThis as typeof globalThis & { [KEY]?: { service?: ResticService } };
  return root[KEY] ??= {};
}
