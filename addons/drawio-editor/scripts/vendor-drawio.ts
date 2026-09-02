#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_WAR_SHA256: Record<string, string> = {
  "31.4.2": "cfc35c3da0ad40f7b16f163e60eaef75b267919a97f939f6bf2f6f2ee608239b",
};
const CLIENT_FILES = ["favicon.ico", "index.html"];
const CLIENT_DIRS = ["images", "img", "js", "math4", "mxgraph", "resources", "styles"];
const CLIENT_PATHS = [...CLIENT_FILES, ...CLIENT_DIRS];
const addonDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(addonDir, "vendor");
const manifest = JSON.parse(readFileSync(join(addonDir, "package.json"), "utf8")) as { version?: string };
const version = String(manifest.version || "").trim();
const expectedSha = EXPECTED_WAR_SHA256[version];
if (!/^\d+\.\d+\.\d+$/.test(version) || !expectedSha) throw new Error(`No trusted draw.io WAR digest is registered for add-on version ${version || "(missing)"}.`);

const tag = `v${version}`;
const sourceUrl = `https://github.com/jgraph/drawio/releases/download/${tag}/draw.war`;
const tempRoot = mkdtempSync(join(tmpdir(), `piclaw-drawio-${version}-`));
const warPath = join(tempRoot, "draw.war");
const extractDir = join(tempRoot, "extract");

function walk(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(path));
    else if (entry.isFile()) results.push(path);
  }
  return results;
}

async function run(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited with code ${exitCode}.`);
}

try {
  const response = await fetch(sourceUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`draw.io download failed: HTTP ${response.status}.`);
  await Bun.write(warPath, response);
  const actualSha = createHash("sha256").update(readFileSync(warPath)).digest("hex");
  if (actualSha !== expectedSha) throw new Error(`draw.io WAR SHA-256 mismatch: expected ${expectedSha}, received ${actualSha}.`);

  mkdirSync(extractDir, { recursive: true });
  await run(["unzip", "-q", warPath, ...CLIENT_FILES, ...CLIENT_DIRS.map((path) => `${path}/*`), "-d", extractDir]);
  for (const required of ["index.html", "js/app.min.js", "js/PreConfig.js", "js/PostConfig.js"]) {
    if (!existsSync(join(extractDir, required))) throw new Error(`draw.io WAR is missing ${required}.`);
  }
  const appSource = readFileSync(join(extractDir, "js", "app.min.js"), "utf8");
  if (!appSource.includes(`EditorUi.VERSION="${version}"`) || !appSource.includes(`mxClient={VERSION:"${version}"`)) {
    throw new Error(`draw.io bundle version does not match ${version}.`);
  }

  const documentation = existsSync(join(vendorDir, ".gitignore")) ? readFileSync(join(vendorDir, ".gitignore")) : null;
  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });
  for (const path of CLIENT_PATHS) cpSync(join(extractDir, path), join(vendorDir, path), { recursive: true });
  if (documentation) writeFileSync(join(vendorDir, ".gitignore"), documentation);

  // The upstream WAR contains whitespace-only defects in unminified JavaScript
  // sources. Normalise them so the committed vendor tree passes the repository's
  // diff hygiene gate without changing executable semantics. Minified one-line
  // bundles do not contain indentation/trailing whitespace and remain byte-exact.
  for (const path of walk(vendorDir)) {
    const isJavaScript = path.endsWith(".js");
    const isLicenseText = /(?:^|\/)LICENSE$/i.test(path);
    if (!isJavaScript && !isLicenseText) continue;
    const source = readFileSync(path, "utf8");
    const lines = source.split("\n").map((line) => line.replace(/\r$/, "").replace(/[ \t]+$/g, ""));
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    const normalized = `${lines.map((line) => {
      if (!isJavaScript) return line;
      const indent = line.match(/^[ \t]+/)?.[0] || "";
      if (!indent) return line;
      let columns = 0;
      for (const char of indent) columns = char === "\t" ? columns + (8 - columns % 8) : columns + 1;
      return `${"\t".repeat(Math.floor(columns / 8))}${" ".repeat(columns % 8)}${line.slice(indent.length)}`;
    }).join("\n")}\n`;
    if (normalized !== source) writeFileSync(path, normalized);
  }

  const files = walk(vendorDir).filter((path) => !path.endsWith("/.gitignore") && !path.endsWith("/drawio.meta.json"));
  const totalSize = files.reduce((sum, path) => sum + statSync(path).size, 0);
  const metadata = {
    manifest_id: "drawio",
    package_name: "drawio",
    package_version: tag,
    package_license: "Apache-2.0",
    package_repository: "https://github.com/jgraph/drawio",
    source_url: sourceUrl,
    source_sha256: expectedSha,
    output_dir: "addons/drawio-editor/vendor",
    total_size_bytes: totalSize,
    copied_items: files.length,
    metadata_file: "addons/drawio-editor/vendor/drawio.meta.json",
  };
  writeFileSync(join(vendorDir, "drawio.meta.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Vendored draw.io ${tag}: ${files.length} files, ${totalSize} bytes, SHA-256 ${expectedSha}.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
