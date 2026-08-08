import { goalDeadlineCheckpointProvider } from "./deadline-checkpoint.js";

type RuntimeApi = {
  registerGoalDeadlineCheckpointProvider?: (provider: typeof goalDeadlineCheckpointProvider) => () => void;
};

const runtime = (globalThis as { __piclaw_runtime?: RuntimeApi }).__piclaw_runtime;
runtime?.registerGoalDeadlineCheckpointProvider?.(goalDeadlineCheckpointProvider);
