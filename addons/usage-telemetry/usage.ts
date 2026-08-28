import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

export interface UsageTelemetryConfig {
  enabled: boolean;
  carbon_host: string;
  carbon_port: number;
  graphite_prefix: string;
  instance_id: string;
  interval_minutes: number;
  graphite_render_url: string;
}

export const DEFAULT_CONFIG: UsageTelemetryConfig = {
  enabled: false,
  carbon_host: "",
  carbon_port: 2003,
  graphite_prefix: "piclaw.usage",
  instance_id: "",
  interval_minutes: 15,
  graphite_render_url: "",
};

export interface Checkpoint { runAt: string; id: number; }
export interface MetricPoint { path: string; value: number; timestamp: number; }
export interface PendingBatch { createdAt: string; checkpoint: Checkpoint; points: MetricPoint[]; }

const MAX_SPOOL_BYTES = 10 * 1024 * 1024;
const MAX_SPOOL_AGE_MS = 7 * 24 * 60 * 60_000;

export function messagesDbPath(): string {
  return process.env.PICLAW_USAGE_TELEMETRY_DB?.trim()
    || process.env.PICLAW_MESSAGES_DB?.trim()
    || join(process.env.PICLAW_STORE?.trim() || "/workspace/.piclaw/store", "messages.db");
}

export function instanceId(config: UsageTelemetryConfig): string {
  return config.instance_id.trim() || hostname();
}

export function graphiteSegment(value: unknown): string {
  const normalized = String(value ?? "unknown").trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "unknown";
}

function stateDir(dbPath: string): string { return join(dirname(dbPath), "usage-telemetry"); }
function statePath(dbPath: string): string { return join(stateDir(dbPath), "state.json"); }
function spoolPath(dbPath: string): string { return join(stateDir(dbPath), "spool.jsonl"); }

function atomicWrite(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, value, "utf8");
  renameSync(tmp, path);
}

export function loadCheckpoint(dbPath = messagesDbPath()): Checkpoint {
  try {
    const parsed = JSON.parse(readFileSync(statePath(dbPath), "utf8"));
    if (typeof parsed?.runAt === "string" && Number.isInteger(parsed?.id)) return parsed;
  } catch { /* first run */ }
  return { runAt: "1970-01-01T00:00:00.000Z", id: 0 };
}

export function saveCheckpoint(checkpoint: Checkpoint, dbPath = messagesDbPath()): void {
  atomicWrite(statePath(dbPath), `${JSON.stringify(checkpoint)}\n`);
}

interface UsageRow {
  id: number; run_at: string; provider: string | null; model: string | null;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  reasoning_tokens: number; total_tokens: number; cost_total: number;
}

export function collectUsage(config: UsageTelemetryConfig, checkpoint: Checkpoint, now = new Date(), dbPath = messagesDbPath()): PendingBatch | null {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    const rows = db.query(`
      SELECT id, run_at, provider, model,
        coalesce(input_tokens, 0) AS input_tokens, coalesce(output_tokens, 0) AS output_tokens,
        coalesce(cache_read_tokens, 0) AS cache_read_tokens, coalesce(cache_write_tokens, 0) AS cache_write_tokens,
        coalesce(reasoning_tokens, 0) AS reasoning_tokens, coalesce(total_tokens, 0) AS total_tokens,
        coalesce(cost_total, 0) AS cost_total
      FROM token_usage
      WHERE run_at > $runAt OR (run_at = $runAt AND id > $id)
      ORDER BY run_at, id
    `).all({ $runAt: checkpoint.runAt, $id: checkpoint.id }) as UsageRow[];
    if (!rows.length) return null;
    const aggregate = new Map<string, UsageRow>();
    for (const row of rows) {
      const key = `${graphiteSegment(row.provider)}\0${graphiteSegment(row.model)}`;
      const found = aggregate.get(key);
      if (found) {
        for (const field of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_tokens", "cost_total"] as const) found[field] += row[field];
      } else aggregate.set(key, { ...row });
    }
    const prefix = `${config.graphite_prefix.split(".").map(graphiteSegment).join(".")}.${graphiteSegment(instanceId(config))}`;
    const timestamp = Math.floor(now.getTime() / 1000);
    const points: MetricPoint[] = [];
    for (const row of aggregate.values()) {
      const base = `${prefix}.${graphiteSegment(row.provider)}.${graphiteSegment(row.model)}`;
      const values: Record<string, number> = {
        "tokens.input": row.input_tokens, "tokens.output": row.output_tokens,
        "tokens.cache_read": row.cache_read_tokens, "tokens.cache_write": row.cache_write_tokens,
        "tokens.reasoning": row.reasoning_tokens, "tokens.total": row.total_tokens,
        "cost.estimated_usd": row.cost_total,
      };
      for (const [metric, value] of Object.entries(values)) points.push({ path: `${base}.${metric}`, value, timestamp });
    }
    const last = rows.at(-1)!;
    return { createdAt: now.toISOString(), checkpoint: { runAt: last.run_at, id: last.id }, points };
  } finally { db.close(); }
}

function loadSpool(dbPath: string): PendingBatch[] {
  try {
    return readFileSync(spoolPath(dbPath), "utf8").split("\n").filter(Boolean).flatMap(line => {
      try { const record = JSON.parse(line) as PendingBatch; return record?.points?.length ? [record] : []; } catch { return []; }
    });
  } catch { return []; }
}

function saveSpool(batches: PendingBatch[], dbPath: string): void {
  const cutoff = Date.now() - MAX_SPOOL_AGE_MS;
  let retained = batches.filter(batch => Date.parse(batch.createdAt) >= cutoff);
  while (retained.length && Buffer.byteLength(retained.map(item => JSON.stringify(item)).join("\n"), "utf8") > MAX_SPOOL_BYTES) retained = retained.slice(1);
  const path = spoolPath(dbPath);
  if (!retained.length) { try { unlinkSync(path); } catch {} return; }
  atomicWrite(path, `${retained.map(item => JSON.stringify(item)).join("\n")}\n`);
}

export function enqueue(batch: PendingBatch, dbPath = messagesDbPath()): void {
  const batches = loadSpool(dbPath); batches.push(batch); saveSpool(batches, dbPath);
}

export async function sendCarbon(host: string, port: number, points: MetricPoint[]): Promise<void> {
  if (!host || !points.length) throw new Error("Carbon host and metric points are required.");
  const payload = points.map(point => `${point.path} ${point.value} ${point.timestamp}`).join("\n") + "\n";
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(5_000);
    socket.once("connect", () => socket.end(payload));
    socket.once("error", reject);
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Carbon connection timed out.")); });
    socket.once("close", hadError => hadError ? undefined : resolve());
  });
}

export async function flushSpool(config: UsageTelemetryConfig, dbPath = messagesDbPath()): Promise<number> {
  const batches = loadSpool(dbPath);
  let sent = 0;
  while (batches.length) {
    await sendCarbon(config.carbon_host, config.carbon_port, batches[0].points);
    batches.shift(); sent += 1;
    saveSpool(batches, dbPath);
  }
  return sent;
}

export async function exportUsage(config: UsageTelemetryConfig, now = new Date(), dbPath = messagesDbPath()): Promise<{ batches: number; points: number }> {
  if (!config.enabled || !config.carbon_host.trim()) return { batches: 0, points: 0 };
  const checkpoint = loadCheckpoint(dbPath);
  const batch = collectUsage(config, checkpoint, now, dbPath);
  if (batch) { enqueue(batch, dbPath); saveCheckpoint(batch.checkpoint, dbPath); }
  const batches = await flushSpool(config, dbPath);
  return { batches, points: batch?.points.length || 0 };
}
