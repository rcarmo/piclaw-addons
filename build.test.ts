import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { packAddon, preservePublishedArchives, verifyPublishedArchives } from "./scripts/lib/pack-addon.js";
import { addonSourceDigest, deprecatedArchives, readDeprecatedAddons, downloadDeprecatedArchive } from "./scripts/lib/deprecated-addons.ts";
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

test('Pages installs Draw.io vendor files directly and rejects an incomplete or nested payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'drawio-pages-package-'));
  try {
    const pkg = join(root, 'addon'), out = join(root, 'drawio.tgz');
    mkdirSync(join(pkg, 'vendor/js'), { recursive: true });
    const manifest = { name: '@rcarmo/piclaw-addon-drawio-editor', version: '31.4.7',
      files: ['vendor'], scripts: { prepack: 'exit 47' } };
    const writeManifest = (files: string[]) => writeFileSync(join(pkg, 'package.json'), JSON.stringify({ ...manifest, files }));
    writeManifest(manifest.files);
    expect(() => packAddon(pkg, out)).toThrow('Draw.io vendor is missing vendor/index.html');
    expect(existsSync(out)).toBe(false);
    const assets = ['vendor/index.html', 'vendor/js/app.min.js', 'vendor/js/PreConfig.js', 'vendor/js/PostConfig.js'];
    for (const asset of assets) writeFileSync(join(pkg, asset), asset);
    packAddon(pkg, out);
    const packed = Bun.spawnSync(['tar', '-tzf', out]);
    expect(packed.exitCode, packed.stderr.toString()).toBe(0);
    for (const asset of assets) expect(packed.stdout.toString().split('\n')).toContain(`package/${asset}`);
    expect(packed.stdout.toString()).not.toContain('vendor.tar.gz');
    const invalid = join(root, 'incomplete.tgz');
    writeManifest(['vendor/index.html']);
    expect(() => packAddon(pkg, invalid)).toThrow('without a nested archive');
    expect(existsSync(invalid)).toBe(false);
    writeFileSync(join(pkg, 'vendor.tar.gz'), 'unwanted nested archive');
    writeManifest(['vendor', 'vendor.tar.gz']);
    expect(() => packAddon(pkg, invalid)).toThrow('without a nested archive');
    expect(existsSync(invalid)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('new tarballs exclude generated reports for legacy and allowlisted packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'addon-reports-'));
  try {
    const pkg = join(root, 'addon');
    mkdirSync(join(pkg, 'tests/reports'), { recursive: true });
    writeFileSync(join(pkg, 'index.ts'), '// production');
    writeFileSync(join(pkg, 'tests/reports/results.json'), '{"generated":true}');
    writeFileSync(join(pkg, 'tests/reports/report.pdf'), 'generated PDF');
    for (const files of [undefined, ['index.ts', 'tests']]) {
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture-addon', version: '2.0.0', ...(files ? { files } : {}) }));
      const archive = join(root, 'addon.tgz');
      packAddon(pkg, archive);
      const entries = Bun.spawnSync(['tar', '-tzf', archive], { stdout: 'pipe' }).stdout.toString();
      expect(entries).toContain('index.ts');
      expect(entries).not.toContain('tests/reports');
      expect(readFileSync(join(pkg, 'tests/reports/results.json'), 'utf8')).toBe('{"generated":true}');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('published versions and historical URLs retain their exact bytes across builds', () => {
  const root = mkdtempSync(join(tmpdir(), 'published-archives-'));
  try {
    const prior = join(root, 'prior'), output = join(root, 'output');
    mkdirSync(prior); mkdirSync(output);
    const files = ['fixture-1.0.0.tgz', 'historical-0.1.0.tgz'];
    for (const file of files) writeFileSync(join(prior, file), `original gzip metadata and payload: ${file}`);
    writeFileSync(join(output, files[0]), 'stale tracked output');
    const published = preservePublishedArchives(prior, output);
    expect([...published].sort()).toEqual([...files].sort());
    for (const file of files) expect(readFileSync(join(output, file))).toEqual(readFileSync(join(prior, file)));
    writeFileSync(join(output, 'new-2.0.0.tgz'), 'new release');
    verifyPublishedArchives(prior, output, published);
    writeFileSync(join(output, files[0]), 'accidental repack');
    expect(() => verifyPublishedArchives(prior, output, published)).toThrow(`Published archive changed: ${files[0]}`);
    preservePublishedArchives(prior, output);
    verifyPublishedArchives(prior, output, published);
    rmSync(join(output, files[1]));
    expect(() => verifyPublishedArchives(prior, output, published)).toThrow();
    expect(buildSource).toContain('if (published.has(`${baseName}-${addon.version}.tgz`))');
    expect(buildSource.indexOf('verifyPublishedArchives(PUBLISHED_PACKAGES')).toBeGreaterThan(buildSource.indexOf('for (const archive of deprecatedArchives(ROOT))'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publication refuses missing, aliased and non-file archive baselines', () => {
  const root = mkdtempSync(join(tmpdir(), 'published-baseline-'));
  try {
    expect(() => preservePublishedArchives(join(root, 'missing'), join(root, 'out'))).toThrow();
    expect(() => preservePublishedArchives(root, root)).toThrow('separate from output');
    expect(() => preservePublishedArchives(root, join(root, 'out'))).toThrow('contains no archives');
    writeFileSync(join(root, 'original'), 'archive');
    symlinkSync(join(root, 'original'), join(root, 'linked.tgz'));
    expect(() => preservePublishedArchives(root, join(root, 'out'))).toThrow('not a regular file');
    expect(buildSource).toContain('if (!PUBLISHED_PACKAGES) throw');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only the selected core add-ons carry the core tag", () => {
  const packageFiles = Array.from(new Bun.Glob("addons/*/package.json").scanSync({ cwd: repoRoot })).sort();
  const deprecated = readDeprecatedAddons(repoRoot);
  const coreSlugs = packageFiles.filter((path) => !(path.split("/")[1]! in deprecated)).flatMap((path) => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
    return manifest.piclaw?.tags?.includes("core") ? [path.split("/")[1]] : [];
  });
  expect(coreSlugs).toEqual(["code-review", "goal", "observability", "restic"]);
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
  expect(Object.keys(deprecated).sort()).toEqual(["delegate", "plan-sidebar", "session-dashboard"]);
  expect(deprecated.delegate).toMatchObject({version:"0.2.22",sourceSha256:addonSourceDigest(join(repoRoot,"addons/delegate"))});
  expect(deprecated["plan-sidebar"]).toMatchObject({version:"0.1.28",sourceSha256:addonSourceDigest(join(repoRoot,"addons/plan-sidebar"))});
  const dashboard = join(repoRoot, "addons/session-dashboard");
  expect(deprecated["session-dashboard"]).toMatchObject({ version: "0.2.6", sourceSha256: addonSourceDigest(dashboard) });
  // The manifest bytes installed sites already hold and Piclaw pins for 0.2.6.
  const manifest = readFileSync(join(dashboard, "package.json"));
  expect(new Bun.CryptoHasher("sha256").update(manifest).digest("hex")).toBe("9daa053e17a8b56713de452b300de7df86c036c9100ad2857d52a6f3c1a7b964");
  expect(deprecatedArchives(repoRoot)).toEqual([{ dir: dashboard, file: "piclaw-addon-session-dashboard-0.2.6.tgz", sha256: deprecated["session-dashboard"]!.archiveSha256 }, {dir:join(repoRoot,"addons/plan-sidebar"),file:"piclaw-addon-plan-sidebar-0.1.28.tgz",sha256:deprecated["plan-sidebar"]!.archiveSha256}, {dir:join(repoRoot,"addons/delegate"),file:"piclaw-addon-delegate-0.2.22.tgz",sha256:deprecated.delegate!.archiveSha256}]);
  expect(buildSource).toContain("for (const archive of deprecatedArchives(ROOT))");
  const root = mkdtempSync(join(tmpdir(), "deprecated-archive-"));
  try {
    const archive = join(root, "dashboard.tgz");
    packAddon(dashboard, archive);
    const extracted = Bun.spawnSync(["tar", "-xOzf", archive, "package/package.json"], { stdout: "pipe" }).stdout;
    expect(Buffer.from(extracted).equals(manifest)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deprecated archives retain exact bytes and reject HTTP failure or changed gzip metadata", async () => {
  const bytes = new TextEncoder().encode("published archive bytes");
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const fake = ((async () => new Response(bytes)) as unknown) as typeof fetch;
  expect(await downloadDeprecatedArchive("https://fixture/archive.tgz", hash, fake)).toEqual(bytes);
  await expect(downloadDeprecatedArchive("https://fixture/archive.tgz", "a".repeat(64), fake)).rejects.toThrow("checksum mismatch");
  const missing = ((async () => new Response(null, { status: 404 })) as unknown) as typeof fetch;
  await expect(downloadDeprecatedArchive("https://fixture/archive.tgz", hash, missing)).rejects.toThrow("unavailable: 404");
});
