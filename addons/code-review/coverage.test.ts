import { test, expect } from "bun:test";
import { acceptanceReport, releaseChecks, scenarioInventory } from "./coverage.js";
test("active Classic checklist has six distinct checks and does not imply a pass", () => {
  const checks = releaseChecks();
  expect(checks.map((check) => check.id)).toEqual(["RC-1", "RC-2", "RC-3", "RC-4", "RC-5", "RC-6"]);
  expect(checks.every((check) => check.check && check.required)).toBe(true);
  expect(checks.find((check) => check.id === "RC-4")?.status).toBe("blocked");
  expect(checks.find((check) => check.id === "RC-6")?.status).toBe("blocked");
  expect(checks.some((check) => check.status === "passed")).toBe(false);
});
test("default report is compact; old scenarios are opt-in reference without acceptance counters", () => {
  const report = acceptanceReport();
  expect(report.scope).toBe("Classic only");
  expect(report.checks).toHaveLength(6);
  expect(report.uxReference).toBe("specs/code-review/review-pane-mock.html");
  expect(report.uxRequirement).toContain("Intentional deviations require approval");
  expect("legacyScenarios" in report).toBe(false);
  const legacy = acceptanceReport(true);
  if (!("legacyScenarios" in legacy)) throw Error("Missing legacy inventory");
  expect(legacy.legacyScenarios).toHaveLength(184);
  expect(legacy.legacyScenarios.every((scenario) => scenario.scope === "reference-only" && !("acceptance" in scenario))).toBe(true);
});
test("archived design scenarios retain their 184 unique traceability IDs", () => {
  const scenarios = scenarioInventory();
  expect(scenarios).toHaveLength(184);
  expect(new Set(scenarios.map((s) => s.id)).size).toBe(184);
  for (let n = 1; n <= 184; n++)
    expect(
      scenarios.some((s) => s.id === `CR-${String(n).padStart(3, "0")}`),
    ).toBe(true);
});
