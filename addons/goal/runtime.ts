import { goalDeadlineCheckpointProvider } from "./deadline-checkpoint.js";

type RuntimeApi = {
  registerGoalDeadlineCheckpointProvider?: (provider: typeof goalDeadlineCheckpointProvider) => (() => void) | void;
};

type GoalRuntimeRegistration = {
  runtime: RuntimeApi;
  provider: typeof goalDeadlineCheckpointProvider;
  unregister: () => void;
};

const REGISTRATION_KEY = Symbol.for("@rcarmo/piclaw-addon-goal/deadline-checkpoint-registration");
const runtimeGlobal = globalThis as typeof globalThis & { __piclaw_runtime?: RuntimeApi } & Record<symbol, unknown>;
const runtime = runtimeGlobal.__piclaw_runtime;
const register = runtime?.registerGoalDeadlineCheckpointProvider;

if (runtime && typeof register === "function") {
  const existing = runtimeGlobal[REGISTRATION_KEY] as GoalRuntimeRegistration | undefined;
  if (existing?.runtime !== runtime || existing.provider !== goalDeadlineCheckpointProvider) {
    try {
      existing?.unregister();
    } catch {
      // A stale core registrar must not make the trusted add-on unloadable.
    }
    try {
      const unregister = register.call(runtime, goalDeadlineCheckpointProvider);
      runtimeGlobal[REGISTRATION_KEY] = {
        runtime,
        provider: goalDeadlineCheckpointProvider,
        unregister: typeof unregister === "function" ? unregister : () => {},
      };
    } catch {
      delete runtimeGlobal[REGISTRATION_KEY];
    }
  }
}
