import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import officeTools, { officeReadParameters, officeWriteParameters } from "./index.ts";

test("office tools use the modern shared TypeBox peer", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
  expect(source).toContain('from "@sinclair/typebox"');
  expect(source).not.toContain('from "typebox"');
  expect(manifest.dependencies?.typebox).toBeUndefined();
  expect(manifest.peerDependencies?.["@sinclair/typebox"]).toBe("*");
});

test("office schemas and extension entrypoint import standalone", () => {
  expect(typeof officeTools).toBe("function");
  expect(officeReadParameters.properties.path).toMatchObject({ type: "string" });
  expect(officeWriteParameters.properties.path).toMatchObject({ type: "string" });
  expect(officeWriteParameters.properties.markdown).toMatchObject({ type: "string" });
});
