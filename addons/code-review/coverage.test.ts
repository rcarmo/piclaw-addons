import { test, expect } from "bun:test";
import { scenarioInventory } from "./coverage.js";
test("all 184 acceptance scenarios retain unique traceability IDs", () => {
  const scenarios = scenarioInventory();
  expect(scenarios).toHaveLength(184);
  expect(new Set(scenarios.map((s) => s.id)).size).toBe(184);
  for (let n = 1; n <= 184; n++)
    expect(
      scenarios.some((s) => s.id === `CR-${String(n).padStart(3, "0")}`),
    ).toBe(true);
});
