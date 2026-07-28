import type { PiclawRuntimeApi } from "../compat/runtime.js";
import type { RemotePeerFoundation } from "../foundation.js";
import { WorkService, type WorkServiceOptions } from "./service.js";

let workService: WorkService | null = null;
let retryTimer: ReturnType<typeof setInterval> | null = null;

export function getWorkService(
  foundation: RemotePeerFoundation,
  runtime: PiclawRuntimeApi,
  options: Omit<WorkServiceOptions, "foundation" | "runtime"> = {},
): WorkService {
  if (workService) return workService;
  workService = new WorkService({ foundation, runtime, ...options });
  return workService;
}

export function startWorkCallbackRetry(service: WorkService): void {
  if (retryTimer) return;
  retryTimer = setInterval(() => { void service.retryDueCallbacks(); }, 30_000);
  retryTimer.unref?.();
}

export function resetWorkServiceForTests(): void {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
  workService = null;
}
