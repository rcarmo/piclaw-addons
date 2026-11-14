import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface DeprecatedAddon {
  reason: string;
  /** The last published version, retained unchanged for existing installations. */
  version: string;
  /** Digest of every source file, so the published release cannot drift in place. */
  sourceSha256: string;
}

/** Hash every file in an add-on directory except local build/test scratch. */
export function addonSourceDigest(dir: string): string {
  const files: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      if (["node_modules", ".artifacts", ".tmp"].includes(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk("");
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    digest.update(`${file}\0${createHash("sha256").update(readFileSync(join(dir, file))).digest("hex")}\n`);
  }
  return digest.digest("hex");
}

/**
 * Deprecation is catalogue metadata, kept outside the package so a published
 * version's bytes never change. Any edit to a deprecated release fails here.
 */
export function readDeprecatedAddons(root: string): Record<string, DeprecatedAddon> {
  const path = join(root, "deprecated-addons.json");
  if (!existsSync(path)) return {};
  const entries = JSON.parse(readFileSync(path, "utf8")) as Record<string, DeprecatedAddon>;
  for (const [slug, entry] of Object.entries(entries)) {
    const dir = join(root, "addons", slug);
    if (!entry?.reason || !entry.version || !entry.sourceSha256) throw new Error(`deprecated add-on ${slug} needs reason, version and sourceSha256`);
    if (!existsSync(join(dir, "package.json"))) throw new Error(`deprecated add-on ${slug} has no package`);
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (version !== entry.version) throw new Error(`deprecated add-on ${slug} is ${version}, not ${entry.version}`);
    if (addonSourceDigest(dir) !== entry.sourceSha256) throw new Error(`deprecated add-on ${slug} changed after deprecation; publish a new version instead`);
  }
  return entries;
}

/** Versioned archives that stay published so existing lockfiles still resolve. */
export function deprecatedArchives(root: string): { dir: string; file: string }[] {
  return Object.entries(readDeprecatedAddons(root)).map(([slug, entry]) => {
    const dir = join(root, "addons", slug);
    const { name } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return { dir, file: `${String(name).replace(/^@[^/]+\//, "")}-${entry.version}.tgz` };
  });
}
