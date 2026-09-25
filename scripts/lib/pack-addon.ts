import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Honour a package's production allowlist; preserve legacy archives otherwise. */
export function packAddon(addonDir: string, outPath: string): void {
  const manifest = JSON.parse(readFileSync(join(addonDir, "package.json"), "utf8"));
  const command = Array.isArray(manifest.files)
    ? [process.execPath, "pm", "pack", "--filename", outPath, "--ignore-scripts", "--quiet"]
    : ["tar", "czf", outPath, "-C", addonDir, "--exclude=./node_modules", "--exclude=./.tmp", "."];
  const result = Bun.spawnSync(command, { cwd: addonDir, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw Error(`Packing ${manifest.name} failed: ${result.stderr.toString() || result.stdout.toString()}`);
}
