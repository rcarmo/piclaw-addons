import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createFixtureMarker,
  requireOwnedFixtureRoot,
  writeEvidence,
} from "./fixture-ownership.js";
test("fixture roots require fresh real owned directories and exclusive evidence", () => {
  const root = mkdtempSync("/tmp/iroh-two-host-test-");
  try {
    expect(() => requireOwnedFixtureRoot(root, "iroh-two-host-")).toThrow(
      "marker",
    );
    createFixtureMarker(root);
    expect(requireOwnedFixtureRoot(root, "iroh-two-host-")).toBe(root);
    writeEvidence(root, "proof.json", "one");
    expect(readFileSync(join(root, "proof.json"), "utf8")).toBe("one");
    expect(() => writeEvidence(root, "proof.json", "two")).toThrow(
      "already exists",
    );
    expect(() =>
      requireOwnedFixtureRoot(root + "/../../workspace", "iroh-two-host-"),
    ).toThrow();
    const outside = mkdtempSync("/tmp/not-iroh-");
    symlinkSync(outside, join(root, "link"));
    expect(() =>
      requireOwnedFixtureRoot(join(root, "link"), "iroh-two-host-"),
    ).toThrow();
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
