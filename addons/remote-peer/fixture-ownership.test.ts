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
  copyEvidence,
} from "./fixture-ownership.js";
test("fixture roots require fresh real owned directories and exclusive evidence", () => {
  const root = mkdtempSync("/tmp/iroh-two-host-test-");
  try {
    expect(() =>
      requireOwnedFixtureRoot(root, "iroh-two-host-", undefined),
    ).toThrow("token");
    const token = createFixtureMarker(root);
    expect(() =>
      requireOwnedFixtureRoot(root, "iroh-two-host-", "0".repeat(48)),
    ).toThrow("token mismatch");
    expect(requireOwnedFixtureRoot(root, "iroh-two-host-", token)).toBe(root);
    writeEvidence(root, "proof.json", "one");
    expect(readFileSync(join(root, "proof.json"), "utf8")).toBe("one");
    expect(() => writeEvidence(root, "proof.json", "two")).toThrow(
      "already exists",
    );
    writeEvidence(root, "source.png", "source");
    copyEvidence(join(root, "source.png"), join(root, "target.png"));
    expect(() =>
      copyEvidence(join(root, "source.png"), join(root, "target.png")),
    ).toThrow();
    expect(() =>
      requireOwnedFixtureRoot(
        "/workspace/iroh-two-host-test-owned",
        "iroh-two-host-",
        token,
      ),
    ).toThrow("canonical /tmp");
    expect(() =>
      requireOwnedFixtureRoot(
        "/tmpfoo/iroh-two-host-test-owned",
        "iroh-two-host-",
        token,
      ),
    ).toThrow("canonical /tmp");
    expect(() =>
      requireOwnedFixtureRoot(
        root + "/../../workspace",
        "iroh-two-host-",
        token,
      ),
    ).toThrow();
    const outside = mkdtempSync("/tmp/not-iroh-");
    symlinkSync(outside, join(root, "link"));
    expect(() =>
      requireOwnedFixtureRoot(join(root, "link"), "iroh-two-host-", token),
    ).toThrow();
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
