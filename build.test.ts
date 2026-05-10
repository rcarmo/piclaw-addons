import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const buildSource = readFileSync(new URL("./build.ts", import.meta.url), "utf8");

test("addon detail pages include a direct tarball download pill", () => {
  expect(buildSource).toContain("function downloadPill(addon: Addon)");
  expect(buildSource).toContain("class=\"download-pill\"");
  expect(buildSource).toContain("href=\"${esc(tarballUrl(addon))}\"");
  expect(buildSource).toContain("${downloadPill(addon)}");
});
