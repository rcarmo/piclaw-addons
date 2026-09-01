import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { collectCompactionTelemetry, exportCompactionTelemetry, loadCompactionCheckpoint } from "./compaction-telemetry.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function dbPath() { const dir = mkdtempSync(join(tmpdir(), "compaction-telemetry-")); dirs.push(dir); return join(dir, "messages.db"); }
const config = { graphite_host: "127.0.0.1", graphite_port: 2003, graphite_prefix: "piclaw", instance_name: "smith.test" };

function createSchema(path: string) {
  const db = new Database(path);
  db.run(`CREATE TABLE compaction_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT, generation_id TEXT UNIQUE, recorded_at TEXT, trigger TEXT, method TEXT,
    execution TEXT, outcome TEXT, provider TEXT, model TEXT, timeout_stage TEXT, input_tokens INTEGER, total_duration_ms INTEGER,
    deterministic_duration_ms INTEGER, time_to_first_token_ms INTEGER, provider_generation_ms INTEGER,
    provider_request_count INTEGER, processed_chunk_count INTEGER, total_chunk_count INTEGER, settlement_timed_out INTEGER
  )`);
  return db;
}

test("collector no-ops safely when the core table is absent", () => {
  const path = dbPath(); const db = new Database(path); db.run("CREATE TABLE token_usage (id INTEGER)"); db.close();
  expect(collectCompactionTelemetry(config, { id: 0 }, new Date("2026-08-30T00:00:00Z"), path)).toBeNull();
});

test("collector exports bounded Graphite paths without chat or secret data", () => {
  const path = dbPath(); const db = createSchema(path);
  db.run(`INSERT INTO compaction_telemetry VALUES (NULL, 'gen-1', '2026-08-30T00:00:00Z', 'manual', 'selective', 'single_pass', 'success', 'local', 'fast-summary', NULL, 48000, 1200, 200, 700, 300, 1, NULL, NULL, 0)`);
  db.close();
  const batch = collectCompactionTelemetry(config, { id: 0 }, new Date("2026-08-30T00:01:00Z"), path)!;
  expect(batch.checkpoint.id).toBe(1);
  expect(batch.points.map(point => point.path)).toEqual(expect.arrayContaining([
    "piclaw.smith_test.compaction.local.fast-summary.selective.single_pass.manual.success.none.attempt.count",
    "piclaw.smith_test.compaction.local.fast-summary.selective.single_pass.manual.success.none.duration.ttft_ms",
  ]));
  const serialized = JSON.stringify(batch);
  expect(serialized).not.toContain("chat_jid");
  expect(serialized).not.toContain("secret");
});

test("export spools, sends, and advances its durable checkpoint", async () => {
  const path = dbPath(); const db = createSchema(path);
  db.run(`INSERT INTO compaction_telemetry VALUES (NULL, 'gen-1', '2026-08-30T00:00:00Z', 'manual', 'selective', 'single_pass', 'success', 'local', 'fast-summary', NULL, 48000, 1200, 200, 700, 300, 1, NULL, NULL, 0)`);
  db.close();
  const received: string[] = [];
  const server = createServer(socket => socket.on("data", data => received.push(data.toString())));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing server address");
    const result = await exportCompactionTelemetry({ ...config, graphite_port: address.port }, new Date("2026-08-30T00:01:00Z"), path);
    expect(result).toMatchObject({ batches: 1 });
    expect(result.points).toBeGreaterThan(0);
    expect(loadCompactionCheckpoint(path)).toEqual({ id: 1 });
    expect(received.join("\n")).toContain("piclaw.smith_test.compaction.local.fast-summary.selective.single_pass.manual.success.none.duration.ttft_ms 700");
    expect(received.join("\n")).not.toContain("piclaw.compaction.smith_test");
    expect(await exportCompactionTelemetry({ ...config, graphite_port: address.port }, new Date("2026-08-30T00:02:00Z"), path)).toEqual({ batches: 0, points: 0 });
  } finally { server.close(); }
});

test("export rewrites queued legacy compaction paths before Carbon delivery", async () => {
  const path = dbPath();
  const db = new Database(path); db.run("CREATE TABLE token_usage (id INTEGER)"); db.close();
  const spool = join(dirname(path), "compaction-telemetry", "spool.jsonl");
  mkdirSync(dirname(spool), { recursive: true });
  writeFileSync(spool, `${JSON.stringify({
    createdAt: new Date().toISOString(),
    checkpoint: { id: 1 },
    points: [{ path: "piclaw.compaction.smith.local.model.selective.single_pass.manual.success.none.attempt.count", value: 1, timestamp: 1 }],
  })}\n`);
  const received: string[] = [];
  const server = createServer(socket => socket.on("data", data => received.push(data.toString())));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing server address");
    expect(await exportCompactionTelemetry({ ...config, graphite_port: address.port }, new Date(), path)).toEqual({ batches: 1, points: 0 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(received.join("\n")).toContain("piclaw.smith.compaction.local.model.selective.single_pass.manual.success.none.attempt.count 1 1");
    expect(received.join("\n")).not.toContain("piclaw.compaction.smith");
  } finally { server.close(); }
});

test("checkpoint defaults to zero", () => {
  expect(loadCompactionCheckpoint(dbPath())).toEqual({ id: 0 });
});
