import { exportUsage, type UsageTelemetryConfig } from "./usage-telemetry.js";
import { exportCompactionTelemetry } from "./compaction-telemetry.js";
import type { TelemetryExportFailure } from "./usage-telemetry-job.js";

declare const self: Worker;
self.addEventListener("message", async event => {
  const { config, dbPath } = event.data as { config: UsageTelemetryConfig; dbPath: string };
  const failures: TelemetryExportFailure[] = [];
  // Preserve independent collector errors: one failed export must not hide the
  // other collector, and each existing exporter closes SQL before network IO.
  for (const [kind, run] of [["usage", exportUsage], ["compaction", exportCompactionTelemetry]] as const) {
    try { await run(config, new Date(), dbPath); }
    catch (error) { failures.push({ kind, message: error instanceof Error ? error.message : String(error) }); }
  }
  self.postMessage({ type: "complete", failures });
}, { once: true });
