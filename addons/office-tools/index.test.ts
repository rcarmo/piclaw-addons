import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import officeTools, { officeReadParameters, officeWriteParameters } from "./index.ts";
import { findBrowserCommand } from "./browser-pdf.ts";

test("office tools declare standalone schema and document dependencies", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
  expect(source).toContain('from "typebox"');
  expect(source).not.toContain('from "@sinclair/typebox"');
  expect(source).not.toContain("../../browser/");
  expect(manifest.peerDependencies?.typebox).toBe("*");
  expect(manifest.dependencies?.fflate).toBe("0.8.2");
  expect(manifest.dependencies?.xlsx).toBe("0.18.5");
});

test("browser discovery is package-local and deterministic", () => {
  const lookedUp: string[] = [];
  const browser = findBrowserCommand({}, (command) => {
    lookedUp.push(command);
    return command === "google-chrome" ? "/usr/bin/google-chrome" : null;
  });
  expect(browser).toEqual({ name: "Google Chrome", command: "/usr/bin/google-chrome" });
  expect(lookedUp).toEqual(["chromium", "chromium-browser", "google-chrome"]);
});

test("office schemas and extension entrypoint import standalone", () => {
  expect(typeof officeTools).toBe("function");
  expect(officeReadParameters.properties.path).toMatchObject({ type: "string" });
  expect(officeWriteParameters.properties.path).toMatchObject({ type: "string" });
  expect(officeWriteParameters.properties.markdown).toMatchObject({ type: "string" });
});
