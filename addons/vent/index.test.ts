import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeVentOutputPath, writeVentEntry } from "./index.ts";

test("normalizeVentOutputPath keeps simple relative paths", () => {
  expect(normalizeVentOutputPath("VENT.md")).toBe("VENT.md");
  expect(normalizeVentOutputPath("notes/vent-log.md")).toBe("notes/vent-log.md");
  expect(normalizeVentOutputPath(".//notes\\VENT.md")).toBe("notes/VENT.md");
});

test("normalizeVentOutputPath rejects absolute and escaping paths", () => {
  expect(() => normalizeVentOutputPath("/tmp/VENT.md")).toThrow();
  expect(() => normalizeVentOutputPath("../VENT.md")).toThrow();
  expect(() => normalizeVentOutputPath("notes/../../VENT.md")).toThrow();
});

test("writeVentEntry creates parent directories and appends markdown entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piclaw-vent-addon-"));
  const now = new Date(2026, 3, 30, 6, 20, 0);

  const result = await writeVentEntry(dir, "notes/VENT.md", "The docs were stale.", "bad_docs", now);
  expect(result.path).toBe("notes/VENT.md");
  expect(result.trigger).toBe("bad_docs");

  const content = readFileSync(join(dir, "notes", "VENT.md"), "utf8");
  expect(content).toContain("# VENT");
  expect(content).toContain("## 26-04-30 06:20 — bad_docs");
  expect(content).toContain("The docs were stale.");
});
