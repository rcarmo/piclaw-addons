import { messagesDbPath, type UsageTelemetryConfig } from "./usage-telemetry.js";

export interface TelemetryExportFailure { kind: "usage" | "compaction"; message: string; }

/** One job owned by the existing non-overlapping telemetry tick. Only detached
 * configuration and a database path cross the worker boundary. */
export async function exportTelemetryOffThread(config: UsageTelemetryConfig, dbPath = messagesDbPath()): Promise<TelemetryExportFailure[]> {
  const worker = new Worker(new URL("./usage-telemetry-worker.ts", import.meta.url).href, { smol: true });
  try {
    return await new Promise<TelemetryExportFailure[]>((resolve, reject) => {
      let result: TelemetryExportFailure[] | undefined, failure: Error | undefined;
      worker.addEventListener("message", event => {
        if (event.data?.type !== "complete" || !Array.isArray(event.data.failures)) return;
        result = event.data.failures;
        worker.terminate();
      });
      worker.addEventListener("error", event => {
        event.preventDefault();
        failure = new Error(event.message || "Telemetry worker failed");
        worker.terminate();
      });
      // A completion message alone does not confirm the job's handle lifetime.
      worker.addEventListener("close", () => {
        if (failure) reject(failure);
        else if (result === undefined) reject(new Error("Telemetry worker closed without a completion result"));
        else resolve(result);
      });
      worker.postMessage({ config, dbPath });
    });
  } finally { worker.terminate(); }
}
