import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Import from an owned directory outside the monorepo; never touch the running addon profile. */
test("code-review standalone entry, startup API and web entry remain self-contained", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-standalone-"));
  const source = import.meta.dir;
  const target = join(root, "addon");
  try {
    cpSync(source, target, {
      recursive: true,
      filter(path) { return !/\.test\.ts$/.test(path); },
    });
    const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    const packaged = [manifest.main, ...manifest.pi.runtime.entries, ...manifest.pi.web.entries,
      "skills/code-review/SKILL.md", "README.md", "anchors.ts", "contracts.ts", "database.ts",
      "dispatch.ts", "host.ts", "markdown.ts", "render-source.ts", "source.ts", "store.ts", "validation.ts", "web/api.ts", "web/pane.ts", "web/styles.ts"];
    expect(manifest.files).toContain("skills/code-review/SKILL.md");
    expect(manifest.files).toContain("web/*.ts");
    expect(manifest.files.some((path: string) => path.endsWith(".test.ts") || path === "provider-fixture.ts")).toBe(false);
    for (const file of packaged) expect(await Bun.file(join(target, file)).exists()).toBe(true);
    expect(manifest.main).toBe("index.ts");
    expect(manifest.pi.runtime.entries).toEqual(["runtime.ts"]);
    expect(manifest.pi.web.entries).toEqual(["web/index.ts"]);
    expect(manifest.pi.skills).toEqual(["skills/code-review"]);
    for (const file of [manifest.main, ...manifest.pi.runtime.entries, ...manifest.pi.web.entries, "skills/code-review/SKILL.md"])
      expect(await Bun.file(join(target, file)).exists()).toBe(true);

    // Startup registration uses only the Piclaw public addon API shape.
    let registered = 0;
    const previous = (globalThis as any).__piclaw_registerAddonConfigApi;
    (globalThis as any).__piclaw_registerAddonConfigApi = (addon: string, action: string) => {
      expect(addon).toBe("code-review");
      expect(action).toBe("action");
      registered++;
    };
    try {
      const runtime = await import(pathToFileURL(join(target, "runtime.ts")).href);
      expect(typeof runtime.reviewAction).toBe("function");
      const addon = await import(pathToFileURL(join(target, "index.ts")).href);
      expect(typeof addon.default).toBe("function");
      const tools: any[] = [];
      addon.default({ registerTool(tool: unknown) { tools.push(tool); }, on() {} });
      expect(tools.map((tool) => tool.name)).toEqual(["code_review"]);
      expect(tools[0].description).toContain("explicit local review dispatch");
    } finally {
      if (previous === undefined) delete (globalThis as any).__piclaw_registerAddonConfigApi;
      else (globalThis as any).__piclaw_registerAddonConfigApi = previous;
    }
    const browser = await Bun.file(join(target, "web/index.ts")).text();
    expect(browser).toContain("workspaceActionsVersion");
    expect(browser).not.toMatch(/\.\.\/\.\.\/runtime\/src/);
    expect(dirname(target)).toBe(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
