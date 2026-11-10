import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectUsage,
  enqueue,
  flushSpool,
  graphiteSegment,
  instanceFirstMetricPrefix,
  loadCheckpoint,
  migrateLegacyCategoryMetricPath,
  saveCheckpoint,
  type UsageTelemetryConfig,
} from "./usage-telemetry.js";

const CONFIG: UsageTelemetryConfig = { graphite_host: "", graphite_port: 2003, graphite_prefix: "piclaw", instance_name: "" };

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "usage-telemetry-")); dirs.push(dir); const path = join(dir, "messages.db"); const db = new Database(path);
  db.exec(`CREATE TABLE token_usage (id INTEGER PRIMARY KEY, run_at TEXT NOT NULL, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_tokens INTEGER, cost_total REAL);`);
  db.query(`INSERT INTO token_usage VALUES (1,'2026-08-01T00:00:00.000Z','OpenAI/Codex','GPT 5.4',2,3,4,5,6,20,0.12),(2,'2026-08-01T00:01:00.000Z','OpenAI/Codex','GPT 5.4',1,2,3,4,5,15,0.08);`).run(); db.close(); return path;
}
function modernFixture(rows: Array<{ actual?: number | null; actualCurrency?:string|null; cost?: number | null; total?: number | null; subtotal?: number | null; known?: number; currency?: string | null; valuation?: string; tokens?: number; provider?: string; model?: string }>) {
  const path = fixture(), db = new Database(path);
  // Build this owned schema/row fixture in one commit, not nine fsynced ALTERs.
  db.transaction(() => {
  db.exec(`DELETE FROM token_usage;
    ALTER TABLE token_usage ADD COLUMN provider_cost_total REAL;
    ALTER TABLE token_usage ADD COLUMN provider_cost_currency TEXT;
    ALTER TABLE token_usage ADD COLUMN catalogue_cost_total REAL;
    ALTER TABLE token_usage ADD COLUMN cost_provenance TEXT;
    ALTER TABLE token_usage ADD COLUMN api_equivalent_cost_microusd INTEGER;
    ALTER TABLE token_usage ADD COLUMN api_equivalent_cost_known INTEGER;
    ALTER TABLE token_usage ADD COLUMN api_equivalent_known_subtotal_microusd INTEGER;
    ALTER TABLE token_usage ADD COLUMN pricing_currency TEXT;
    ALTER TABLE token_usage ADD COLUMN valuation_provenance TEXT;`);
  for (const [i, row] of rows.entries()) db.query(`INSERT INTO token_usage
    (id,run_at,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,total_tokens,cost_total,
    provider_cost_total,catalogue_cost_total,cost_provenance,api_equivalent_cost_microusd,api_equivalent_cost_known,api_equivalent_known_subtotal_microusd,pricing_currency,valuation_provenance)
    VALUES (?,?,?,?,?,0,0,0,0,?,?,?,?,?,?,?,?,?,?)`).run(i + 1, '2026-08-01T00:00:00.000Z', row.provider ?? 'provider', row.model ?? 'model', row.tokens ?? 2, row.tokens ?? 2, row.cost ?? 0,
      row.actual ?? null, row.total == null ? null : row.total / 1e6, row.actual != null ? 'provider_reported' : 'unavailable',
      row.total ?? null, row.known ?? 0, row.subtotal ?? null, row.currency ?? null, row.valuation ?? 'unavailable');
  for(const [i,row] of rows.entries())db.query('UPDATE token_usage SET provider_cost_currency=? WHERE id=?').run(row.actualCurrency??null,i+1);
  }).immediate();
  db.close(); return path;
}
function values(path: string) {
  return new Map(collectUsage({ ...CONFIG, instance_name: 'fixture' }, loadCheckpoint(path), new Date('2026-08-01T01:00:00Z'), path)!.points
    .map(point => [point.path.replace('piclaw.fixture.usage.provider.model.', ''), point.value]));
}

test('provider native amounts never become USD estimates and API-equivalent valuation keeps its own source', () => {
  const path = modernFixture([{ actual: 2, cost: 2, total: 3_000_000, subtotal: 3_000_000, known: 1, currency: 'USD', valuation: 'catalogue_estimate' }]);
  const points = values(path);
  expect(points.get('cost.provider_reported.currency_unknown.latest_known_amount')).toBe(2);
  expect(points.get('cost.api_equivalent_usd.known_subtotal')).toBe(3);
  expect(points.has('cost.estimated_usd')).toBe(false);
  expect(points.has('cost.provider_reported.usd')).toBe(false);
});
test('supplied native zero survives with zero tokens; absent native cost and unavailable valuation stay unknown', () => {
  const explicit = values(modernFixture([{ actual: 0, cost: 0, tokens: 0 }]));
  expect(explicit.get('cost.provider_reported.currency_unknown.latest_known_amount')).toBe(0);
  expect(explicit.get('cost.provider_reported.currency_unknown.known_rows')).toBe(1);
  const absent = values(modernFixture([{ actual: null, cost: 0, subtotal: 0, tokens: 0 }]));
  expect(absent.has('cost.provider_reported.currency_unknown.latest_known_amount')).toBe(false);
  expect(absent.has('cost.api_equivalent_usd.known_subtotal')).toBe(false);
  expect(absent.get('cost.provider_reported.currency_unknown.unknown_rows')).toBe(1);
  expect(absent.get('cost.api_equivalent_usd.unknown_rows')).toBe(1);
});
test('partial USD valuation exposes its known subtotal; documented-free zero is distinct from unavailable zero', () => {
  const partial = values(modernFixture([{ subtotal: 1_500_000, currency: 'USD', valuation: 'unavailable' }]));
  expect(partial.get('cost.api_equivalent_usd.known_subtotal')).toBe(1.5);
  expect(partial.get('cost.api_equivalent_usd.partial_rows')).toBe(1);
  const free = values(modernFixture([{ total: 0, subtotal: 0, known: 1, currency: 'USD', valuation: 'documented_free' }]));
  expect(free.get('cost.api_equivalent_usd.known_subtotal')).toBe(0);
  expect(free.get('cost.api_equivalent_usd.complete_rows')).toBe(1);
});
test('unknown-currency native amounts are never summed, including across a later missing observation', () => {
  const points = values(modernFixture([{ actual: 2 }, { actual: 0 }, { actual: null }]));
  expect(points.get('cost.provider_reported.currency_unknown.latest_known_amount')).toBe(0);
  expect(points.get('cost.provider_reported.currency_unknown.known_rows')).toBe(2);
  expect(points.get('cost.provider_reported.currency_unknown.unknown_rows')).toBe(1);
  expect(points.get('cost.provider_reported.currency_unknown.latest_known_at')).toBe(Date.parse('2026-08-01T00:00:00Z') / 1000);
  expect(points.get('tokens.total')).toBe(6);
});
test('non-USD or malformed valuation does not silently become USD, while tokens and native observations remain', () => {
  const points = values(modernFixture([{ actual: 4, total: 2_000_000, subtotal: 2_000_000, known: 1, currency: 'EUR', valuation: 'catalogue_estimate' }, { actual: Infinity, subtotal: -1, currency: 'USD' }]));
  expect(points.has('cost.api_equivalent_usd.known_subtotal')).toBe(false);
  expect(points.get('cost.api_equivalent_usd.unknown_rows')).toBe(2);
  expect(points.get('cost.provider_reported.currency_unknown.latest_known_amount')).toBe(4);
  expect(points.get('tokens.total')).toBe(4);
});
test('reader needs no financial tables and changes neither canonical rows nor its read checkpoint', () => {
  const path = modernFixture([{ actual: 0, total: 1_000_000, subtotal: 1_000_000, known: 1, currency: 'USD', valuation: 'catalogue_estimate' }]);
  const db = new Database(path), before = db.serialize();
  expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'budget_%'").all()).toEqual([]);
  const batch = collectUsage(CONFIG, loadCheckpoint(path), new Date('2026-08-01T01:00:00Z'), path)!;
  expect(batch.checkpoint).toEqual({ runAt: '2026-08-01T00:00:00.000Z', id: 1 });
  expect(db.serialize()).toEqual(before); expect(loadCheckpoint(path).id).toBe(0);
  saveCheckpoint(batch.checkpoint, path); expect(collectUsage(CONFIG, loadCheckpoint(path), new Date(), path)).toBeNull();
  db.close();
});

test("sanitizes Graphite path segments and builds instance-first prefixes", () => {
  expect(graphiteSegment("OpenAI/Codex 5.4")).toBe("openai_codex_5_4");
  expect(graphiteSegment("...")).toBe("unknown");
  expect(instanceFirstMetricPrefix("piclaw.prod", "Smith Main", "usage")).toBe("piclaw.prod.smith_main.usage");
});

test("rewrites only legacy category-first paths", () => {
  expect(migrateLegacyCategoryMetricPath("piclaw.usage.smith.openai.gpt.tokens.total", "piclaw", "usage"))
    .toBe("piclaw.smith.usage.openai.gpt.tokens.total");
  expect(migrateLegacyCategoryMetricPath("piclaw.prod.usage.smith.openai.gpt.tokens.total", "piclaw.prod", "usage"))
    .toBe("piclaw.prod.smith.usage.openai.gpt.tokens.total");
  expect(migrateLegacyCategoryMetricPath("piclaw.smith.usage.openai.gpt.tokens.total", "piclaw", "usage"))
    .toBe("piclaw.smith.usage.openai.gpt.tokens.total");
  expect(migrateLegacyCategoryMetricPath("piclaw.compaction.smith.local.model.attempt.count", "piclaw", "usage"))
    .toBe("piclaw.compaction.smith.local.model.attempt.count");
});
test("collects local usage into provider/model points and tracks checkpoint", () => {
  const path = fixture(); const batch = collectUsage({ ...CONFIG, instance_name: "Smith Main" }, loadCheckpoint(path), new Date("2026-08-01T01:00:00Z"), path)!;
  expect(batch.points.find(point => point.path.endsWith("tokens.total"))?.value).toBe(35);
  expect(batch.points.find(point => point.path.endsWith('cost.legacy_unclassified.currency_unknown.latest_stored_amount'))?.value).toBe(.08);
  expect(batch.points.find(point => point.path.endsWith('cost.legacy_unclassified.currency_unknown.rows'))?.value).toBe(2);
  expect(batch.points.some(point => point.path.endsWith('cost.estimated_usd'))).toBe(false);
  expect(batch.points[0].path).toContain("piclaw.smith_main.usage.openai_codex.gpt_5_4");
  saveCheckpoint(batch.checkpoint, path); expect(collectUsage(CONFIG, loadCheckpoint(path), new Date(), path)).toBeNull();
});
test('legacy NULL is not a stored zero and no currency or provider provenance is invented', () => {
  for (const amount of [null, 0]) {
    const path = fixture(), db = new Database(path);
    db.exec('DELETE FROM token_usage');
    db.query("INSERT INTO token_usage (id,run_at,provider,model,cost_total) VALUES(1,'2026-08-01T00:00:00.000Z','provider','model',?)").run(amount);
    db.close(); const points = values(path);
    expect(points.get('cost.legacy_unclassified.currency_unknown.latest_stored_amount')).toBe(amount === null ? undefined : 0);
    expect(points.has('cost.provider_reported.currency_unknown.latest_known_amount')).toBe(false);
    expect(points.has('cost.api_equivalent_usd.known_subtotal')).toBe(false);
  }
});
test('partial cost schemas preserve tagged stored amounts without guessing units', () => {
  const path = fixture(), db = new Database(path);
  db.exec("ALTER TABLE token_usage ADD COLUMN cost_provenance TEXT; UPDATE token_usage SET cost_provenance='provider_reported'"); db.close();
  const batch = collectUsage(CONFIG, loadCheckpoint(path), new Date(), path)!;
  expect(batch.points.find(point => point.path.endsWith('cost.legacy_unclassified.currency_unknown.latest_stored_amount'))?.value).toBe(.08);
  expect(batch.points.some(point => point.path.endsWith('cost.api_equivalent_usd.known_subtotal'))).toBe(false);
  expect(batch.points.some(point => point.path.endsWith('cost.provider_reported.currency_unknown.latest_known_amount'))).toBe(false);
});
test('contradictory completeness retains a valid subtotal; undocumented zero stays unknown', () => {
  const zero = values(modernFixture([{ total: 0, subtotal: 0, known: 1, currency: 'USD', valuation: 'catalogue_estimate' }]));
  expect(zero.has('cost.api_equivalent_usd.known_subtotal')).toBe(false);
  expect(zero.get('cost.api_equivalent_usd.unknown_rows')).toBe(1);
  const partial = values(modernFixture([{ total: 3_000_000, subtotal: 2_000_000, known: 1, currency: 'USD', valuation: 'catalogue_estimate' }]));
  expect(partial.get('cost.api_equivalent_usd.known_subtotal')).toBe(2);
  expect(partial.get('cost.api_equivalent_usd.partial_rows')).toBe(1);
  expect(partial.get('cost.api_equivalent_usd.complete_rows')).toBe(0);
});
test('only explicit USD known subtotals are additive and row-cursor ties remain exact', () => {
  const path = modernFixture([
    { actual: 2, total: 3_000_000, subtotal: 3_000_000, known: 1, currency: 'USD', valuation: 'catalogue_estimate' },
    { actual: 5, subtotal: 1_000_000, currency: 'USD' }, { subtotal: 0, currency: 'USD' },
  ]);
  const points = values(path);
  expect(points.get('cost.api_equivalent_usd.known_subtotal')).toBe(4);
  expect(points.get('cost.api_equivalent_usd.complete_rows')).toBe(1);
  expect(points.get('cost.api_equivalent_usd.partial_rows')).toBe(1);
  expect(points.get('cost.api_equivalent_usd.unknown_rows')).toBe(1);
  expect(points.get('cost.provider_reported.currency_unknown.latest_known_amount')).toBe(5);
  const batch = collectUsage(CONFIG, loadCheckpoint(path), new Date(), path)!;
  expect(batch.checkpoint.id).toBe(3); saveCheckpoint(batch.checkpoint, path);
  const db = new Database(path);
  db.query("INSERT INTO token_usage(id,run_at,provider,model,total_tokens,cost_total) VALUES(4,'2026-08-01T00:00:00.000Z','provider','model',9,NULL)").run(); db.close();
  const next = collectUsage(CONFIG, loadCheckpoint(path), new Date(), path)!;
  expect(next.checkpoint.id).toBe(4);
  expect(next.points.find(point => point.path.endsWith('tokens.total'))?.value).toBe(9);
  expect(next.points.some(point => point.path.endsWith('latest_known_amount'))).toBe(false);
});
test('ambiguous queued costs retain value and time under unclassified units without dual writes', async () => {
  const path = fixture(), received: string[] = [];
  const server = createServer(socket => socket.on('data', data => received.push(data.toString())));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    enqueue({ createdAt: new Date().toISOString(), checkpoint: { runAt: 'x', id: 1 }, points: [
      { path: 'piclaw.usage.fixture.provider.model.cost.estimated_usd', value: 2, timestamp: 123 },
      { path: 'piclaw.fixture.usage.provider.model.cost.estimated_usd', value: 0, timestamp: 124 },
      { path: 'piclaw.fixture.usage.provider.model.cost.api_equivalent_usd.known_subtotal', value: 3, timestamp: 125 },
    ] }, path);
    const spool = join(path, '..', 'usage-telemetry', 'spool.jsonl'), before = readFileSync(spool, 'utf8');
    await expect(flushSpool({ ...CONFIG, graphite_host: '' }, path)).rejects.toThrow('Carbon host');
    expect(readFileSync(spool, 'utf8')).toBe(before);
    expect(await flushSpool({ ...CONFIG, graphite_host: '127.0.0.1', graphite_port: port }, path)).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 20)); const text = received.join('');
    expect(text).toContain('piclaw.fixture.usage.provider.model.cost.legacy_unclassified.currency_unknown.stored_batch_value 2 123');
    expect(text).toContain('piclaw.fixture.usage.provider.model.cost.legacy_unclassified.currency_unknown.stored_batch_value 0 124');
    expect(text).toContain('cost.api_equivalent_usd.known_subtotal 3 125');
    expect(text).not.toContain('cost.estimated_usd');
    expect(text.trim().split('\n')).toHaveLength(3);
    expect(await flushSpool({ ...CONFIG, graphite_host: '127.0.0.1', graphite_port: port }, path)).toBe(0);
  } finally { server.close(); }
});

test("flushes the durable spool to Carbon", async () => {
  const path = fixture(); const received: string[] = []; const server = createServer(socket => socket.on("data", data => received.push(data.toString()))); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port; enqueue({ createdAt: new Date().toISOString(), checkpoint: { runAt: "x", id: 1 }, points: [{ path: "piclaw.usage.smith.openai.gpt.tokens.total", value: 42, timestamp: 1 }] }, path);
  expect(await flushSpool({ ...CONFIG, graphite_host: "127.0.0.1", graphite_port: port }, path)).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(received.join("")).toContain("piclaw.smith.usage.openai.gpt.tokens.total 42 1");
  expect(received.join("")).not.toContain("piclaw.usage.smith");
  server.close();
});


test('provider currency totals keep USD, EUR and unknown observations separate, including supplied zero',()=>{
 const points=values(modernFixture([{actual:0,actualCurrency:'USD'},{actual:2,actualCurrency:'USD'},{actual:3,actualCurrency:'EUR'},{actual:99},{actual:1}]));
 expect(points.get('cost.provider_reported.usd.total')).toBe(2);expect(points.get('cost.provider_reported.usd.known_rows')).toBe(2);
 expect(points.get('cost.provider_reported.eur.total')).toBe(3);expect(points.get('cost.provider_reported.eur.known_rows')).toBe(1);
 expect(points.get('cost.provider_reported.currency_unknown.latest_known_amount')).toBe(1);expect(points.get('cost.provider_reported.currency_unknown.known_rows')).toBe(2);
 expect(points.has('cost.estimated_usd')).toBe(false);
});
