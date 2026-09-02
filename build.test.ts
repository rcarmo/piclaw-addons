import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL(".", import.meta.url).pathname;
const buildSource = readFileSync(new URL("./build.ts", import.meta.url), "utf8");

test("addon detail pages include a direct tarball download pill", () => {
  expect(buildSource).toContain("function downloadPill(addon: Addon)");
  expect(buildSource).toContain("class=\"download-pill\"");
  expect(buildSource).toContain("href=\"${esc(tarballUrl(addon))}\"");
  expect(buildSource).toContain("${downloadPill(addon)}");
});

test("core-tagged cards render an accessible top-right bookmark", () => {
  expect(buildSource).toContain("function coreBookmark(addon: Addon)");
  expect(buildSource).toContain('if (!addon.tags.includes("core")) return ""');
  expect(buildSource).toContain('class="core-bookmark" role="img" aria-label="Core add-on"');
  expect(buildSource).toContain("Core add-on — recommended for most Piclaw installations");
  expect(buildSource).toContain('class="card${a.tags.includes("core") ? " card-core" : ""}"');
  expect(buildSource).toContain("${coreBookmark(a)}");
  expect(buildSource).toContain(".core-bookmark{position:absolute");
  expect(buildSource).toContain(">CORE</text>");
});

test("only the selected foundational add-ons carry the core tag", () => {
  const packageFiles = Array.from(new Bun.Glob("addons/*/package.json").scanSync({ cwd: repoRoot })).sort();
  const coreSlugs = packageFiles.flatMap((path) => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
    return manifest.piclaw?.tags?.includes("core") ? [path.split("/")[1]] : [];
  });
  expect(coreSlugs).toEqual(["delegate", "goal", "observability", "plan-sidebar", "session-dashboard"]);

  const catalog = JSON.parse(readFileSync(join(repoRoot, "catalog.json"), "utf8"));
  const catalogCoreSlugs = catalog.addons.filter((addon: any) => addon.tags?.includes("core")).map((addon: any) => addon.slug).sort();
  expect(catalogCoreSlugs).toEqual(coreSlugs);
  expect(Object.fromEntries(catalog.addons.filter((addon: any) => catalogCoreSlugs.includes(addon.slug)).map((addon: any) => [addon.slug, addon.version]))).toEqual({
    delegate: "0.2.8",
    goal: "0.1.46",
    observability: "0.1.14",
    "plan-sidebar": "0.1.24",
    "session-dashboard": "0.2.4",
  });
});
