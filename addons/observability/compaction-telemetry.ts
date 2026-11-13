import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  graphiteSegment,
  instanceFirstMetricPrefix,
  messagesDbPath,
  migrateLegacyCategoryMetricPath,
  atomicWrite, readTelemetrySpool, writeTelemetrySpool, sendCarbon,
  type TelemetryBatch, type MetricPoint,
} from "./usage-telemetry.js";

export interface CompactionTelemetryConfig {
  graphite_host: string;
  graphite_port: number;
  graphite_prefix: string;
  instance_name: string;
}

interface CompactionRow {
  id: number; recorded_at: string; trigger: string; method: string; execution: string; outcome: string;
  provider: string | null; model: string | null; timeout_stage: string | null; input_tokens: number | null;
  total_duration_ms: number; deterministic_duration_ms: number | null; time_to_first_token_ms: number | null;
  provider_generation_ms: number | null; provider_request_count: number;
  processed_chunk_count: number | null; total_chunk_count: number | null; settlement_timed_out: number;
}

interface CompactionCheckpoint { id: number; }
type CompactionBatch = TelemetryBatch<CompactionCheckpoint>;

const instance = (config: CompactionTelemetryConfig) => config.instance_name.trim() || hostname();
const root = (dbPath: string) => join(dirname(dbPath), "compaction-telemetry");
const checkpointPath = (dbPath: string) => join(root(dbPath), "state.json");
const spoolPath = (dbPath: string) => join(root(dbPath), "spool.jsonl");

export function loadCompactionCheckpoint(dbPath = messagesDbPath()): CompactionCheckpoint {
  try { const value = JSON.parse(readFileSync(checkpointPath(dbPath), "utf8")); if (Number.isInteger(value?.id)) return { id: value.id }; } catch {}
  return { id: 0 };
}

function saveCheckpoint(checkpoint: CompactionCheckpoint, dbPath: string): void {
  atomicWrite(checkpointPath(dbPath), `${JSON.stringify(checkpoint)}\n`);
}

export function collectCompactionTelemetry(
  config: CompactionTelemetryConfig,
  checkpoint: CompactionCheckpoint,
  now = new Date(),
  dbPath = messagesDbPath(),
): CompactionBatch | null {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    const table = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='compaction_telemetry'").get();
    if (!table) return null;
    const rows = db.query("SELECT * FROM compaction_telemetry WHERE id > ? ORDER BY id LIMIT 2000").all(checkpoint.id) as CompactionRow[];
    if (!rows.length) return null;
    const timestamp = Math.floor(now.getTime() / 1000);
    const prefix = instanceFirstMetricPrefix(config.graphite_prefix, instance(config), "compaction");
    const points = new Map<string, MetricPoint>();
    const counters = new Set(["attempt.count", "provider.request_count", "settlement.timeout"]);
    for (const row of rows) {
      const dimensions = [row.provider, row.model, row.method, row.execution, row.trigger, row.outcome, row.timeout_stage || "none"].map(graphiteSegment).join(".");
      const base = `${prefix}.${dimensions}`;
      const values: Record<string, number | null> = {
        "attempt.count": 1,
        "input.tokens": row.input_tokens,
        "duration.total_ms": row.total_duration_ms,
        "duration.deterministic_ms": row.deterministic_duration_ms,
        "duration.ttft_ms": row.time_to_first_token_ms,
        "duration.provider_generation_ms": row.provider_generation_ms,
        "provider.request_count": row.provider_request_count,
        "chunks.processed": row.processed_chunk_count,
        "chunks.total": row.total_chunk_count,
        "settlement.timeout": row.settlement_timed_out,
      };
      for (const [metric, value] of Object.entries(values)) if (value != null && Number.isFinite(value)) {
        const path = `${base}.${metric}`;
        const previous = points.get(path);
        points.set(path, { path, value: counters.has(metric) ? (previous?.value ?? 0) + value : value, timestamp });
      }
    }
    return { createdAt: now.toISOString(), checkpoint: { id: rows.at(-1)!.id }, points: [...points.values()] };
  } finally { db.close(); }
}

export async function exportCompactionTelemetry(config: CompactionTelemetryConfig, now = new Date(), dbPath = messagesDbPath()): Promise<{ batches: number; points: number }> {
  if (!config.graphite_host.trim()) return { batches: 0, points: 0 };
  const checkpoint = loadCompactionCheckpoint(dbPath);
  const batch = collectCompactionTelemetry(config, checkpoint, now, dbPath);
  const batches = readTelemetrySpool<CompactionCheckpoint>(spoolPath(dbPath));
  if (batch) { batches.push(batch); writeTelemetrySpool(spoolPath(dbPath), batches); saveCheckpoint(batch.checkpoint, dbPath); }
  let sent = 0;
  while (batches.length) {
    const points = batches[0].points.map(point => ({
      ...point,
      path: migrateLegacyCategoryMetricPath(point.path, config.graphite_prefix, "compaction"),
    }));
    await sendCarbon(config.graphite_host, config.graphite_port, points);
    batches.shift(); sent += 1; writeTelemetrySpool(spoolPath(dbPath), batches);
  }
  return { batches: sent, points: batch?.points.length ?? 0 };
}
