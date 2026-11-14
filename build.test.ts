import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { packAddon } from "./scripts/lib/pack-addon.js";
import { addonSourceDigest, deprecatedArchives, readDeprecatedAddons } from "./scripts/lib/deprecated-addons.ts";
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

test("public tarballs honour production files and preserve legacy exclusions", () => {
  expect(buildSource).toContain('packAddon(addonDir, outPath)');
  const root = mkdtempSync(join(tmpdir(), 'addon-pack-'));
  try {
    const pkg = join(root, 'addon');
    mkdirSync(join(pkg, 'node_modules'), { recursive: true });
    mkdirSync(join(pkg, '.tmp'));
    for (const name of ['index.ts', 'index.test.ts', 'node_modules/secret.ts', '.tmp/secret.ts']) writeFileSync(join(pkg, name), '// fixture');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture-addon', version: '1.0.0', files: ['index.ts'] }));
    const archive = join(root, 'addon.tgz');
    packAddon(pkg, archive);
    const entries = () => Bun.spawnSync(['tar', '-tzf', archive], { stdout: 'pipe' }).stdout.toString().trim().split('\n');
    expect(entries().sort()).toEqual(['package/index.ts', 'package/package.json']);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture-addon', version: '1.0.0' }));
    packAddon(pkg, archive);
    expect(entries()).toContain('./index.ts');
    expect(entries().some((entry) => entry.includes('node_modules') || entry.includes('.tmp'))).toBe(false);
    expect(() => packAddon(pkg, join(root, 'missing', 'no.tgz'))).toThrow('Packing fixture-addon failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only the selected core add-ons carry the core tag", () => {
  const packageFiles = Array.from(new Bun.Glob("addons/*/package.json").scanSync({ cwd: repoRoot })).sort();
  const deprecated = readDeprecatedAddons(repoRoot);
  const coreSlugs = packageFiles.filter((path) => !(path.split("/")[1]! in deprecated)).flatMap((path) => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
    return manifest.piclaw?.tags?.includes("core") ? [path.split("/")[1]] : [];
  });
  expect(coreSlugs).toEqual(["code-review", "delegate", "goal", "observability", "plan-sidebar", "restic"]);
  const dashboard = JSON.parse(readFileSync(join(repoRoot, 'addons/session-dashboard/package.json'), 'utf8'));
  expect(dashboard.deprecated).toBeUndefined();
  expect(deprecated["session-dashboard"]?.reason).toContain('Workbench Sessions');

  const catalog = JSON.parse(readFileSync(join(repoRoot, "catalog.json"), "utf8"));
  const catalogCoreSlugs = catalog.addons.filter((addon: any) => addon.tags?.includes("core")).map((addon: any) => addon.slug).sort();
  expect(catalogCoreSlugs).toEqual(coreSlugs);
  expect(catalog.addons.some((addon: any) => addon.slug === 'session-dashboard')).toBe(false);
  const manifestVersions = Object.fromEntries(coreSlugs.map((slug) => [slug, JSON.parse(readFileSync(join(repoRoot, "addons", slug!, "package.json"), "utf8")).version]));
  expect(Object.fromEntries(catalog.addons.filter((addon: any) => catalogCoreSlugs.includes(addon.slug)).map((addon: any) => [addon.slug, addon.version]))).toEqual(manifestVersions);
});

test("deprecated add-ons keep their exact published sources and versioned archives", () => {
  const deprecated = readDeprecatedAddons(repoRoot);
  expect(Object.keys(deprecated)).toEqual(["session-dashboard"]);
  const dashboard = join(repoRoot, "addons/session-dashboard");
  expect(deprecated["session-dashboard"]).toMatchObject({ version: "0.2.6", sourceSha256: addonSourceDigest(dashboard) });
  // The manifest bytes installed sites already hold and Piclaw pins for 0.2.6.
  const manifest = readFileSync(join(dashboard, "package.json"));
  expect(new Bun.CryptoHasher("sha256").update(manifest).digest("hex")).toBe("9daa053e17a8b56713de452b300de7df86c036c9100ad2857d52a6f3c1a7b964");
  expect(deprecatedArchives(repoRoot)).toEqual([{ dir: dashboard, file: "piclaw-addon-session-dashboard-0.2.6.tgz" }]);
  expect(buildSource).toContain("for (const archive of deprecatedArchives(ROOT))");
  const root = mkdtempSync(join(tmpdir(), "deprecated-archive-"));
  try {
    const archive = join(root, "dashboard.tgz");
    packAddon(dashboard, archive);
    const extracted = Bun.spawnSync(["tar", "-xOzf", archive, "package/package.json"], { stdout: "pipe" }).stdout;
    expect(Buffer.from(extracted).equals(manifest)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
