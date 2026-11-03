import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

test('non-additive native, legacy and old ambiguous costs are rejected before any Graphite query', async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('[]'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (const metric of ['cost.estimated_usd', 'cost.provider_reported.currency_unknown.latest_known_amount', 'cost.legacy_unclassified.currency_unknown.stored_batch_value']) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'usage-telemetry-chart.ts'), '--render-url', `http://127.0.0.1:${port}`, '--metric', metric], { stdout: 'pipe', stderr: 'pipe' });
      const error = new Response(child.stderr).text();
      expect(await child.exited).toBe(1); expect(await error).toContain('not additive');
    }
    expect(requests).toBe(0);
  } finally { server.close(); }
});
test('USD subtotal chart retains fractional values, explicit zero and unknown gaps without summing native units', async () => {
  let target = '';
  const epoch = Math.floor(Date.now() / 1000), day = new Date(epoch * 1000).toISOString().slice(0, 10);
  const server = createServer((request, response) => {
    target = new URL(request.url!, 'http://127.0.0.1').searchParams.get('target')!;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([
      { target: 'piclaw.known.usage.provider.model.cost.api_equivalent_usd.known_subtotal', datapoints: [[0.25, epoch]] },
      { target: 'piclaw.zero.usage.provider.model.cost.api_equivalent_usd.known_subtotal', datapoints: [[0, epoch]] },
      { target: 'piclaw.unknown.usage.provider.model.cost.api_equivalent_usd.known_subtotal', datapoints: [[null, epoch]] },
      { target: 'piclaw.native.usage.provider.model.cost.provider_reported.currency_unknown.latest_known_amount', datapoints: [[999, epoch]] },
    ]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), 'usage-cost-chart-')); dirs.push(dir);
  const output = join(dir, 'cost.svg');
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'usage-telemetry-chart.ts'), '--render-url', `http://127.0.0.1:${port}`, '--metric', 'cost.api_equivalent_usd.known_subtotal', '--output', output], { stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
    expect(target).toBe('piclaw.*.usage.*.*.cost.api_equivalent_usd.known_subtotal');
    const svg = readFileSync(output, 'utf8');
    expect(svg).toContain('API-equivalent known subtotal (USD)');
    expect(svg).toContain(`data-instance="known" data-day="${day}" data-value="0.25"`);
    expect(svg).toContain(`data-instance="zero" data-day="${day}" data-value="0"`);
    expect(svg).not.toContain('data-instance="unknown"'); expect(svg).not.toContain('data-instance="native"');
    expect(svg).toContain('Missing observations are unknown');
  } finally { server.close(); }
});

test("queries and groups instance-first usage metrics", async () => {
  let requestedTarget = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    requestedTarget = url.searchParams.get("target") || "";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([
      { target: "piclaw.smith.usage.github-copilot.gpt_5_6_sol.tokens.total", datapoints: [[42, 1_788_192_000]] },
      { target: "piclaw.redshirt.usage.github-copilot.gpt_5_6_sol.tokens.total", datapoints: [[24, 1_788_192_000]] },
      { target: "piclaw.usage.legacy.github-copilot.gpt_5_6_sol.tokens.total", datapoints: [[999, 1_788_192_000]] },
    ]));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  const dir = mkdtempSync(join(tmpdir(), "usage-telemetry-chart-")); dirs.push(dir);
  const output = join(dir, "chart.svg");
  try {
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "usage-telemetry-chart.ts"),
      "--render-url", `http://127.0.0.1:${address.port}`,
      "--days", "7",
      "--output", output,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(requestedTarget).toBe("piclaw.*.usage.*.*.tokens.total");
    const svg = readFileSync(output, "utf8");
    expect(svg).toContain("smith");
    expect(svg).toContain("redshirt");
    expect(svg).not.toContain("legacy");
  } finally {
    server.close();
  }
});
