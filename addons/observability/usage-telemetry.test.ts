import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsage, enqueue, flushSpool, graphiteSegment, loadCheckpoint, saveCheckpoint, type UsageTelemetryConfig } from "./usage-telemetry.js";

const CONFIG: UsageTelemetryConfig = { graphite_host: "", graphite_port: 2003, graphite_prefix: "piclaw", instance_name: "" };

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "usage-telemetry-")); dirs.push(dir); const path = join(dir, "messages.db"); const db = new Database(path);
  db.exec(`CREATE TABLE token_usage (id INTEGER PRIMARY KEY, run_at TEXT NOT NULL, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_tokens INTEGER, cost_total REAL);`);
  db.query(`INSERT INTO token_usage VALUES (1,'2026-08-01T00:00:00.000Z','OpenAI/Codex','GPT 5.4',2,3,4,5,6,20,0.12),(2,'2026-08-01T00:01:00.000Z','OpenAI/Codex','GPT 5.4',1,2,3,4,5,15,0.08);`).run(); db.close(); return path;
}
test("sanitizes Graphite path segments", () => { expect(graphiteSegment("OpenAI/Codex 5.4")).toBe("openai_codex_5_4"); expect(graphiteSegment("...")).toBe("unknown"); });
test("collects local usage into provider/model points and tracks checkpoint", () => {
  const path = fixture(); const batch = collectUsage({ ...CONFIG, instance_name: "Smith Main" }, loadCheckpoint(path), new Date("2026-08-01T01:00:00Z"), path)!;
  expect(batch.points.find(point => point.path.endsWith("tokens.total"))?.value).toBe(35);
  expect(batch.points.find(point => point.path.endsWith("cost.estimated_usd"))?.value).toBeCloseTo(.2);
  expect(batch.points[0].path).toContain("piclaw.usage.smith_main.openai_codex.gpt_5_4");
  saveCheckpoint(batch.checkpoint, path); expect(collectUsage(CONFIG, loadCheckpoint(path), new Date(), path)).toBeNull();
});
test("flushes the durable spool to Carbon", async () => {
  const path = fixture(); const received: string[] = []; const server = createServer(socket => socket.on("data", data => received.push(data.toString()))); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port; enqueue({ createdAt: new Date().toISOString(), checkpoint: { runAt: "x", id: 1 }, points: [{ path: "piclaw.usage.smith.openai.gpt.tokens.total", value: 42, timestamp: 1 }] }, path);
  expect(await flushSpool({ ...CONFIG, graphite_host: "127.0.0.1", graphite_port: port }, path)).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 20)); expect(received.join("")).toContain("42 1"); server.close();
});
