import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const addonDir = import.meta.dir;

describe("smart-compaction addon", () => {
  test("exports an extension entrypoint", async () => {
    const mod = await import("./index.ts");
    expect(typeof mod.default).toBe("function");
    expect(typeof mod.smartCompaction).toBe("function");
  });

  test("ports core stale-ctx UI resilience", () => {
    const source = readFileSync(resolve(addonDir, "index.ts"), "utf8");
    expect(source).toContain("function resilientUi");
    expect(source).toContain("makeResilientCtx(rawCtx as any)");
    expect(source).toContain("/stale|disposed|invalid/i");
  });

  test("ports core progressive merge safety guards", () => {
    const source = readFileSync(resolve(addonDir, "src", "progressive.ts"), "utf8");
    expect(source).toContain("MAX_PROGRESSIVE_MERGE_PASSES = 12");
    expect(source).toContain("Progressive compaction merge made no progress");
    expect(source).toContain("Progressive compaction time budget exhausted during merge pass");
    expect(source).toContain("Progressive compaction time budget exhausted before final merge");
    expect(source).toContain("timeoutMs: input.timeoutMs");
    expect(source).toContain("startedAt: input.startedAt");
  });
});
