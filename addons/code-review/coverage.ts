/** Read-only inventory. Unit references are links, never an acceptance pass. */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dir, "../..");
const features = join(root, "specs/code-review/features");
export function scenarioInventory() {
  return readdirSync(features).filter(name => name.endsWith(".feature")).sort().flatMap(file => {
    const content = readFileSync(join(features, file), "utf8");
    return [...content.matchAll(/^\s*Scenario: (CR-\d+) (.+)$/gm)].map(match => ({ id: match[1]!, title: match[2]!, feature: file }));
  });
}
if (import.meta.main) {
  const scenarios = scenarioInventory();
  const tests = readdirSync(import.meta.dir).filter(name => name.endsWith(".test.ts"));
  console.log(JSON.stringify({ scenarios: scenarios.map(s => ({ ...s, unitReferences: tests.filter(file => readFileSync(join(import.meta.dir, file), "utf8").includes(s.id)), acceptance: "pending" })), note: "Unit references do not establish complete scenario coverage. Real acceptance step assertions and host evidence remain required." }, null, 2));
}
