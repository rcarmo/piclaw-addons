import { describe, expect, test } from "bun:test";
import { resolveRefreshedSkillModel } from "./src/index.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const addonDir = import.meta.dir;

test("skill-model-effort package keeps upstream attribution and Piclaw metadata", () => {
  const manifest = JSON.parse(readFileSync(join(addonDir, "package.json"), "utf8"));

  expect(manifest.name).toBe("@rcarmo/piclaw-addon-skill-model-effort");
  expect(manifest.pi.extensions).toEqual(["src/index.ts"]);
  expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
  expect(manifest.peerDependencies["@sinclair/typebox"]).toBe("*");
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
