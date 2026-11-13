import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { exportTelemetryOffThread } from "./usage-telemetry-job.js";
import { loadCheckpoint } from "./usage-telemetry.js";

function fixture(rows: number) {
  const dir = mkdtempSync(join(tmpdir(), "telemetry-worker-")), path = join(dir, "messages.db");
  const db = new Database(path);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE token_usage(id INTEGER PRIMARY KEY,run_at TEXT,provider TEXT,model TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,total_tokens INTEGER,cost_total REAL)`);
  const insert = db.query("INSERT INTO token_usage VALUES(?,'2026-11-13T00:00:00Z','fixture','model',1,0,0,0,0,1,NULL)");
  db.transaction(() => { for (let id = 1; id <= rows; id++) insert.run(id); })();
  return { dir, path, db, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("real worker exports bounded incremental usage without duplicate totals while a WAL writer is held", async () => {
  const f = fixture(2505), received: string[] = [];
  const server = createServer(socket => { let data = ""; socket.on("data", chunk => { data += chunk; }); socket.on("end", () => { received.push(data); socket.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { graphite_host: "127.0.0.1", graphite_port: (server.address() as any).port, graphite_prefix: "piclaw", instance_name: "fixture" };
  const lock = new Database(f.path); lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  let beats = 0;
  const timer = setInterval(() => { beats++; }, 5);
  try {
    expect(await exportTelemetryOffThread(config, f.path)).toEqual([]);
    expect(loadCheckpoint(f.path).id).toBe(2000);
    expect(received.join("")).toContain("piclaw.fixture.usage.fixture.model.tokens.input 2000 ");
    expect(await exportTelemetryOffThread(config, f.path)).toEqual([]);
    expect(loadCheckpoint(f.path).id).toBe(2505);
    expect(received.join("")).toContain("piclaw.fixture.usage.fixture.model.tokens.input 505 ");
    expect(await exportTelemetryOffThread(config, f.path)).toEqual([]);
    expect(received).toHaveLength(2);
    expect(beats).toBeGreaterThan(1);
    expect(lock.inTransaction).toBe(true);
  } finally { clearInterval(timer); lock.exec("ROLLBACK"); lock.close(); server.close(); f.close(); }
}, 15000);

test("the existing timer owns one real worker and shutdown joins its pending export", async () => {
  const f = fixture(1), RealWorker = globalThis.Worker;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.on('data', data => { if (data.toString().includes('.usage.')) entered.resolve(); });
    socket.on('end', () => { void release.promise.then(() => socket.end()); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let created = 0, active = 0, maximum = 0;
  globalThis.Worker = class {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      created++; active++; maximum = Math.max(maximum, active);
      const worker = new RealWorker(...args);
      worker.addEventListener('close', () => { active--; }, { once: true });
      return worker;
    }
  } as unknown as typeof Worker;
  const ticks: Array<() => void> = [], original = globalThis.setInterval;
  const timer = spyOn(globalThis, 'setInterval').mockImplementation(((fn: any, delay: number, ...args: any[]) => {
    if (delay === 60000) ticks.push(() => fn(...args));
    return original(fn, delay, ...args);
  }) as any);
  const previous = process.env.PICLAW_USAGE_TELEMETRY_DB; process.env.PICLAW_USAGE_TELEMETRY_DB = f.path;
  const native = await import(`./index.ts?worker-lifecycle=${crypto.randomUUID()}`);
  const unbind = native.bindObservabilityConfiguration({ assertCurrent() {}, read: () => ({ enabled: true, appinsights_enabled: false, graphite_enabled: true, usage_telemetry_enabled: true, usage_telemetry_interval_minutes: 1, graphite_host: '127.0.0.1', graphite_port: (server.address() as any).port, instance_name: 'fixture' }), write() {} });
  try {
    await native.prepareObservabilityRuntime(); await entered.promise;
    expect(ticks).toHaveLength(1);
    for (let n = 0; n < 5; n++) ticks[0]!();
    expect(created).toBe(1); expect(maximum).toBe(1);
    let stopped = false;
    const closing = native.shutdownObservabilityRuntime().then(() => { stopped = true; });
    await Bun.sleep(20); expect(stopped).toBe(false); expect(active).toBe(1);
    release.resolve(); await closing;
    expect(stopped).toBe(true); expect(active).toBe(0); expect(maximum).toBe(1);
  } finally {
    release.resolve(); await native.shutdownObservabilityRuntime(); unbind(); timer.mockRestore(); globalThis.Worker = RealWorker;
    if (previous === undefined) delete process.env.PICLAW_USAGE_TELEMETRY_DB; else process.env.PICLAW_USAGE_TELEMETRY_DB = previous;
    for (const socket of sockets) socket.destroy(); server.close(); f.close();
  }
}, 15000);

test("real worker reports collector and transport failures without advancing or losing queued evidence", async () => {
  const f = fixture(1);
  // Reserve then release an owned loopback endpoint to get a real refused send.
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const config = { graphite_host: "127.0.0.1", graphite_port: port, graphite_prefix: "piclaw", instance_name: "fixture" };
  try {
    const failures = await exportTelemetryOffThread(config, f.path);
    expect(failures.map(failure => failure.kind)).toEqual(["usage"]);
    expect(loadCheckpoint(f.path).id).toBe(1);
    expect(existsSync(join(f.dir, "usage-telemetry", "spool.jsonl"))).toBe(true);
    f.db.exec("DROP TABLE token_usage");
    const missing = await exportTelemetryOffThread(config, f.path);
    expect(missing.map(failure => failure.kind)).toEqual(["usage"]);
    expect(missing[0]!.message).toContain("token_usage");
    expect(loadCheckpoint(f.path).id).toBe(1);
  } finally { f.close(); }
}, 15000);
