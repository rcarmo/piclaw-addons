#!/usr/bin/env bun
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const addonDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(addonDir, "vendor");
const outputPath = join(addonDir, "vendor.tar.gz");
const files: Record<string, Uint8Array> = {};

function collect(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.isFile() && entry.name !== ".gitignore") {
      files[relative(vendorDir, path).replaceAll("\\", "/")] = readFileSync(path);
    }
  }
}

collect(vendorDir);
await Bun.Archive.write(outputPath, files, { compress: "gzip", level: 9 });
console.log(`Packed ${Object.keys(files).length} draw.io vendor files into ${outputPath}.`);
