import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import sampleAddon from "./index.ts";

test("sample addon exports an extension entrypoint", () => {
  expect(typeof sampleAddon).toBe("function");
});

test("sample compat storage avoids runtime source imports", () => {
  const source = readFileSync(join(import.meta.dir, "compat", "extension-kv.ts"), "utf8");
  expect(source).not.toContain("require(");
  expect(source).not.toContain("piclaw/runtime/src");
});
