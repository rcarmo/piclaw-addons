import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import imageProcessing, { ImageProcessSchema } from "./index.ts";

test("image processing declares its standalone runtime dependencies", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
  expect(source).toContain('from "typebox"');
  expect(source).not.toContain('from "@sinclair/typebox"');
  expect(manifest.peerDependencies?.typebox).toBe("*");
  expect(manifest.dependencies?.gifenc).toBe("1.0.3");
  expect(manifest.peerDependencies?.["@sinclair/typebox"]).toBeUndefined();
});

test("gifenc dependency produces an animated GIF payload", async () => {
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const rgba = new Uint8Array([255, 0, 0, 255]);
  const palette = quantize(rgba, 2, { format: "rgba4444" });
  const gif = GIFEncoder();
  gif.writeFrame(applyPalette(rgba, palette, "rgba4444"), 1, 1, { palette });
  gif.finish();
  expect(new TextDecoder().decode(gif.bytes().slice(0, 6))).toBe("GIF89a");
});

test("image processing keeps the intentional number-or-array delay union", () => {
  expect(typeof imageProcessing).toBe("function");
  expect(ImageProcessSchema.properties.delay.anyOf).toHaveLength(2);
  expect(ImageProcessSchema.properties.delay.anyOf[0]).toMatchObject({ type: "integer" });
  expect(ImageProcessSchema.properties.delay.anyOf[1]).toMatchObject({ type: "array" });
});
