import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

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
