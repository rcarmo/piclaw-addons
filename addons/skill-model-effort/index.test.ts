import { describe, expect, test } from "bun:test";
import skillModelEffort, { resolveRefreshedSkillModel } from "./src/index.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const addonDir = import.meta.dir;

test("skill-model-effort package keeps upstream attribution and Piclaw metadata", () => {
  const manifest = JSON.parse(readFileSync(join(addonDir, "package.json"), "utf8"));

  expect(manifest.name).toBe("@rcarmo/piclaw-addon-skill-model-effort");
  expect(manifest.pi.extensions).toEqual(["src/index.ts"]);
  expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
  expect(manifest.peerDependencies["@sinclair/typebox"]).toBeUndefined();
  expect(manifest.piclaw.tags).toContain("skills");
  expect(manifest.piclaw.tags).toContain("thinking");

  expect(readFileSync(join(addonDir, "LICENSE.upstream"), "utf8")).toContain("MIT License");
  expect(readFileSync(join(addonDir, "README.md"), "utf8")).toContain("robzolkos/pi-skill-model-effort");
});

test("skill-model-effort source imports the Piclaw package scope", () => {
  const source = readFileSync(join(addonDir, "src", "index.ts"), "utf8");

  expect(source).toContain("@earendil-works/pi-coding-agent");
  expect(source).not.toContain("@mariozechner/pi-coding-agent");
  expect(source).toContain("parseFrontmatter");
  expect(source).toContain('pi.on("input"');
  expect(source).toContain('pi.on("tool_call"');
  expect(source).toContain('pi.on("agent_end"');
});

test("custom starts have no prompt and still refresh the skill map for reads", async () => {
  const handlers = new Map<string, Function>();
  skillModelEffort({ on(event: string, handler: Function) { handlers.set(event, handler); } } as any);
  const ctx = { cwd: addonDir };
  await handlers.get("before_agent_start")!({
    messageType: "custom",
    message: { customType: "fixture", content: "continue", display: false },
    systemPromptOptions: { skills: [{ name: "fixture", filePath: join(addonDir, "README.md") }] },
  }, ctx);
  // The known README has no runtime frontmatter, so reading it needs no model/UI API.
  await handlers.get("tool_call")!({ toolName: "read", input: { path: join(addonDir, "README.md") } }, ctx);
  await handlers.get("before_agent_start")!({
    messageType: "user", prompt: '<skill name="fixture">',
    systemPromptOptions: { skills: [{ name: "fixture", filePath: join(addonDir, "README.md") }] },
  }, ctx);
});

test("legacy and discriminated user starts apply effort; custom starts refresh maps for reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-effort-compat-"));
  try {
    const filePath = join(root, "SKILL.md");
    writeFileSync(filePath, "---\nname: fixture\neffort: high\n---\nFixture");
    for (const shape of [{ prompt: '<skill name="fixture">' }, { messageType: "user", prompt: '<skill name="fixture">' }, { messageType: "custom", message: { customType: "fixture", content: "continue", display: false } }]) {
      const handlers = new Map<string, Function>();
      const levels: string[] = [];
      skillModelEffort({ on(event: string, handler: Function) { handlers.set(event, handler); }, getThinkingLevel() { return "medium"; }, setThinkingLevel(level: string) { levels.push(level); } } as any);
      const ctx = { cwd: root, hasUI: false };
      await handlers.get("before_agent_start")!({ ...shape, systemPromptOptions: { skills: [{ name: "fixture", filePath }] } }, ctx);
      expect(levels).toEqual(shape.messageType === "custom" ? [] : ["high"]);
      if (shape.messageType === "custom") {
        await handlers.get("tool_call")!({ toolName: "read", input: { path: filePath } }, ctx);
        expect(levels).toEqual(["high"]);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe("skill model resolution", () => {
  const stale = { provider: "test", id: "stale", name: "Stale" } as any;
  const fresh = { provider: "test", id: "fresh", name: "Fresh" } as any;

  test("awaits refresh before taking one coherent model snapshot", async () => {
    let refreshed = false;
    let reads = 0;
    const resolved = await resolveRefreshedSkillModel("test/fresh", {
      modelRegistry: {
        async refresh() {
          await Bun.sleep(5);
          refreshed = true;
        },
        getAll() {
          reads++;
          return refreshed ? [fresh] : [stale];
        },
      } as any,
    });

    expect(reads).toBe(1);
    expect(resolved).toEqual({ model: fresh, refreshError: undefined });
  });

  test("uses the last-good snapshot and reports refresh failure", async () => {
    const resolved = await resolveRefreshedSkillModel("test/stale", {
      modelRegistry: {
        async refresh() { throw new Error("offline"); },
        getAll() { return [stale]; },
      } as any,
    });

    expect(resolved.model).toBe(stale);
    expect(resolved.refreshError).toBe("offline");
  });

  test("keeps ambiguous short names unresolved", async () => {
    const resolved = await resolveRefreshedSkillModel("shared", {
      modelRegistry: {
        async refresh() {},
        getAll() {
          return [
            { ...stale, id: "shared", provider: "one" },
            { ...fresh, id: "shared", provider: "two" },
          ];
        },
      } as any,
    });

    expect(resolved.model).toBeUndefined();
  });
});
