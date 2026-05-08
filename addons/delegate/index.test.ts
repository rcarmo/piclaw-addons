import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import delegateAddon, { delegateTaskPreview } from "./delegate.ts";

const addonDir = import.meta.dir;

describe("delegate addon", () => {
  test("exports an extension entrypoint", () => {
    expect(typeof delegateAddon).toBe("function");
  });

  test("delegate task previews are compact and single-line", () => {
    const preview = delegateTaskPreview("  Review\n\nthis long task and summarize the important findings for the user  ", 32);
    expect(preview).toBe("Review this long task and summa…");
  });

  test("delegate surfaces progress and timeline feedback guidance", () => {
    const source = readFileSync(resolve(addonDir, "delegate.ts"), "utf8");
    expect(source).toContain("setWorkingMessage");
    expect(source).toContain("setStatus?.(DELEGATE_STATUS_KEY");
    expect(source).toContain("clearDelegateProgress(ctx)");
    expect(source).toContain("visible one-sentence timeline update");
    expect(source).toContain("what you are delegating");
  });

  test("delegate manifest declares typebox for runtime and compatibility", () => {
    const manifest = JSON.parse(readFileSync(resolve(addonDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.["@sinclair/typebox"]).toBe("*");
    expect(manifest.peerDependencies?.["@sinclair/typebox"]).toBe("*");
    expect(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("*");
  });
});
