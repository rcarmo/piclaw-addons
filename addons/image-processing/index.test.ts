import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import imageProcessing, { ImageProcessSchema } from "./index.ts";

test("image processing uses the modern shared TypeBox peer", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
  expect(source).toContain('from "@sinclair/typebox"');
  expect(source).not.toContain('from "typebox"');
  expect(manifest.dependencies?.typebox).toBeUndefined();
  expect(manifest.peerDependencies?.["@sinclair/typebox"]).toBe("*");
});

test("image processing keeps the intentional number-or-array delay union", () => {
  expect(typeof imageProcessing).toBe("function");
  expect(ImageProcessSchema.properties.delay.anyOf).toHaveLength(2);
  expect(ImageProcessSchema.properties.delay.anyOf[0]).toMatchObject({ type: "integer" });
  expect(ImageProcessSchema.properties.delay.anyOf[1]).toMatchObject({ type: "array" });
});
