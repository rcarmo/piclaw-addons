import { expect, test, describe } from "bun:test";
import { join } from "node:path";

describe("late-night-regrets", () => {
  test("train script exists and is valid TypeScript", async () => {
    const scriptPath = join(import.meta.dir, "scripts", "train-interaction-quality-bayes.ts");
    const file = Bun.file(scriptPath);
    expect(await file.exists()).toBe(true);
    const content = await file.text();
    expect(content).toContain("Multinomial Naive Bayes");
    expect(content).toContain("interaction quality");
    expect(content).toContain("CATEGORIES");
    expect(content.length).toBeGreaterThan(5000);
  });

  test("SKILL.md exists and has required frontmatter", async () => {
    const skillPath = join(import.meta.dir, "skills", "late-night-regrets", "SKILL.md");
    const content = await Bun.file(skillPath).text();
    expect(content).toContain("name: late-night-regrets");
    expect(content).toContain("description:");
    expect(content).toContain("## Categories");
    expect(content).toContain("## Nightly flow");
  });

  test("package.json has correct metadata", async () => {
    const pkgPath = join(import.meta.dir, "package.json");
    const pkg = JSON.parse(await Bun.file(pkgPath).text());
    expect(pkg.name).toBe("@rcarmo/piclaw-addon-late-night-regrets");
    expect(pkg.piclaw.type).toBe("extension");
    expect(pkg.piclaw.tags).toContain("bayesian");
    expect(pkg.piclaw.tags).toContain("self-improvement");
    expect(pkg.piclaw.skills).toContain("skills/late-night-regrets");
  });

  test("extension entry point exports a default function", async () => {
    // Can't fully test without piclaw runtime, but verify the module shape
    const mod = await import("./index.ts");
    expect(typeof mod.default).toBe("function");
    expect(typeof mod.getTrainScriptPath).toBe("function");
    expect(typeof mod.getAttentionFilePath).toBe("function");
  });
});
