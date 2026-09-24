import { test, expect } from "bun:test";
import {
  compareSource,
  highlightSource,
  highlightSourcePage,
  sourceLines,
} from "./render-source.js";
test("CR-147/148/149 tokenise complete source context and preserve text", () => {
  const text =
    "/* first\r\n * const still comment\r\n */\r\nconst n: number = 42;\r\nconst value = `first\r\nsecond`;\r\n";
  const result = highlightSource("sample.ts", text);
  expect(result.highlighted).toBe(true);
  expect(result.lines[1]?.html).toContain("tok-comment");
  expect(result.lines[5]?.html).toContain("tok-string2");
  expect(result.lines.map((l) => l.text)).toEqual(sourceLines(text));
  expect(result.lines[3]?.html).toContain("tok-number");
});
test("CR-082/121/150/151 hostile or unsupported source stays escaped plain text", () => {
  const text = "<img src=x onerror=alert(1)>";
  expect(highlightSource("sample.txt", text)).toMatchObject({
    highlighted: false,
    language: "text",
  });
  expect(highlightSource("sample.txt", text).lines[0]?.html).toBe(
    "&lt;img src=x onerror=alert(1)&gt;",
  );
  expect(highlightSource("big.ts", "x".repeat(96 * 1024 + 1)).highlighted).toBe(
    false,
  );
  expect(highlightSource("README.md", "# Heading").lines[0]?.html).toContain(
    "tok-heading",
  );
});
test("paged fallback escapes only requested lines and leaves cached token pages isolated", () => {
  const long = Array.from({ length: 3000 }, (_, i) => `<line ${i + 1}>`).join("\n");
  const fallback = highlightSourcePage("large.ts", long, 2500, 5);
  expect(fallback).toMatchObject({ highlighted: false, total: 3000 });
  expect(fallback.lines.map((line) => line.number)).toEqual([2501, 2502, 2503, 2504, 2505]);
  expect(fallback.lines[0]?.html).toBe("&lt;line 2501&gt;");
  expect(highlightSourcePage("large.ts", long, 0, 5, new Set([9, 2, null])).lines.map((line) => line.number)).toEqual([2, 9]);
  const first = highlightSourcePage("small.ts", "const answer = 42;\n", 0, 1);
  first.lines[0]!.html = "mutated";
  expect(highlightSourcePage("small.ts", "const answer = 42;\n", 0, 1).lines[0]!.html).not.toBe("mutated");
  const direct = highlightSource("small.ts", "const answer = 42;\n");
  direct.lines[0]!.html = "poisoned";
  expect(highlightSource("small.ts", "const answer = 42;\n").lines[0]!.html).not.toBe("poisoned");
  expect(highlightSourcePage("small.ts", "const answer = 42;\n", 0, 1).lines[0]!.html).not.toBe("poisoned");
});
test("CR-130 diff coordinates come from independent snapshots", () => {
  expect(compareSource("one\ntwo\nthree\n", "one\nchanged\nthree\n")).toEqual([
    { kind: "context", oldLine: 1, newLine: 1, text: "one" },
    { kind: "deleted", oldLine: 2, newLine: null, text: "two" },
    { kind: "added", oldLine: null, newLine: 2, text: "changed" },
    { kind: "context", oldLine: 3, newLine: 3, text: "three" },
  ]);
  expect(compareSource(null, "new\n")[0]).toEqual({
    kind: "added",
    oldLine: null,
    newLine: 1,
    text: "new",
  });
  expect(compareSource("old\n", null)[0]).toEqual({
    kind: "deleted",
    oldLine: 1,
    newLine: null,
    text: "old",
  });
});
