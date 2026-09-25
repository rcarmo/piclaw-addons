/** Read-only release checklist; legacy scenario traceability is opt-in. */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dir, "../..");
const features = join(root, "specs/code-review/features");
export function releaseChecks() {
  const content = readFileSync(join(root, "specs/code-review/ACCEPTANCE.md"), "utf8");
  return [...content.matchAll(/^\| (RC-\d+) \| ([^|]+) \| ([^|]+) \| (pending|partial|blocked|passed) \|$/gm)]
    .map((match) => ({ id: match[1]!, check: match[2]!.trim(), required: match[3]!.trim(), status: match[4]! }));
}
export function scenarioInventory() {
  return readdirSync(features)
    .filter((name) => name.endsWith(".feature"))
    .sort()
    .flatMap((file) => {
      const content = readFileSync(join(features, file), "utf8");
      return [...content.matchAll(/^\s*Scenario: (CR-\d+) (.+)$/gm)].map(
        (match) => ({ id: match[1]!, title: match[2]!, feature: file }),
      );
    });
}
export function acceptanceReport(includeLegacy = false) {
  const report = {
    scope: "Classic only",
    checklist: "specs/code-review/ACCEPTANCE.md",
    uxReference: "specs/code-review/review-pane-mock.html",
    uxRequirement: "Preserve the agreed mock UX; verify layout and interactions before signing off RC-1–RC-3. Intentional deviations require approval.",
    checks: releaseChecks(),
    note: "Statuses are recorded evidence, not inferred test passes. The 184 older scenarios are reference only; use --legacy to list them.",
  };
  if (!includeLegacy) return report;
  const tests = readdirSync(import.meta.dir).filter((name) =>
    name.endsWith(".test.ts"),
  );
  return {
    ...report,
    legacyScenarios: scenarioInventory().map((scenario) => ({
      ...scenario,
      scope: "reference-only",
      unitReferences: tests.filter((file) => readFileSync(join(import.meta.dir, file), "utf8").includes(scenario.id)),
    })),
  };
}
if (import.meta.main) {
  console.log(JSON.stringify(acceptanceReport(process.argv.includes("--legacy")), null, 2));
}
