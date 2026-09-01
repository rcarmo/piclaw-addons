import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  graphiteSegment,
  instanceFirstMetricPrefix,
  messagesDbPath,
  migrateLegacyCategoryMetricPath,
  type MetricPoint,
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
interface CompactionBatch { createdAt: string; checkpoint: CompactionCheckpoint; points: MetricPoint[]; }
const MAX_SPOOL_BYTES = 10 * 1024 * 1024;
const MAX_SPOOL_AGE_MS = 7 * 24 * 60 * 60_000;

const instance = (config: CompactionTelemetryConfig) => config.instance_name.trim() || hostname();
const root = (dbPath: string) => join(dirname(dbPath), "compaction-telemetry");
const checkpointPath = (dbPath: string) => join(root(dbPath), "state.json");
const spoolPath = (dbPath: string) => join(root(dbPath), "spool.jsonl");

function atomicWrite(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, value, "utf8");
  renameSync(tmp, path);
}

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
    const points: MetricPoint[] = [];
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
      for (const [metric, value] of Object.entries(values)) if (value != null && Number.isFinite(value)) points.push({ path: `${base}.${metric}`, value, timestamp });
    }
    return { createdAt: now.toISOString(), checkpoint: { id: rows.at(-1)!.id }, points };
  } finally { db.close(); }
}

function loadSpool(dbPath: string): CompactionBatch[] {
  try { return readFileSync(spoolPath(dbPath), "utf8").split("\n").filter(Boolean).flatMap(line => { try { const item = JSON.parse(line); return item?.points?.length ? [item] : []; } catch { return []; } }); } catch { return []; }
}
function saveSpool(batches: CompactionBatch[], dbPath: string): void {
  const cutoff = Date.now() - MAX_SPOOL_AGE_MS;
  let retained = batches.filter(batch => Date.parse(batch.createdAt) >= cutoff);
  while (retained.length && Buffer.byteLength(retained.map(JSON.stringify).join("\n"), "utf8") > MAX_SPOOL_BYTES) retained = retained.slice(1);
  const path = spoolPath(dbPath);
  if (!retained.length) { try { unlinkSync(path); } catch {} return; }
  atomicWrite(path, `${retained.map(JSON.stringify).join("\n")}\n`);
}
async function send(host: string, port: number, points: MetricPoint[]): Promise<void> {
  const payload = points.map(point => `${point.path} ${point.value} ${point.timestamp}`).join("\n") + "\n";
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port }); socket.setTimeout(5_000);
    socket.once("connect", () => socket.end(payload)); socket.once("error", reject);
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Carbon connection timed out.")); });
    socket.once("close", hadError => hadError ? undefined : resolve());
  });
}

export async function exportCompactionTelemetry(config: CompactionTelemetryConfig, now = new Date(), dbPath = messagesDbPath()): Promise<{ batches: number; points: number }> {
  if (!config.graphite_host.trim()) return { batches: 0, points: 0 };
  const checkpoint = loadCompactionCheckpoint(dbPath);
  const batch = collectCompactionTelemetry(config, checkpoint, now, dbPath);
  const batches = loadSpool(dbPath);
  if (batch) { batches.push(batch); saveSpool(batches, dbPath); saveCheckpoint(batch.checkpoint, dbPath); }
  let sent = 0;
  while (batches.length) {
    const points = batches[0].points.map(point => ({
      ...point,
      path: migrateLegacyCategoryMetricPath(point.path, config.graphite_prefix, "compaction"),
    }));
    await send(config.graphite_host, config.graphite_port, points);
    batches.shift(); sent += 1; saveSpool(batches, dbPath);
  }
  return { batches: sent, points: batch?.points.length ?? 0 };
}
