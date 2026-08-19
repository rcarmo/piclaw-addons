import { expect, test } from "bun:test";

import { compileM365SyncPattern } from "../index.ts";

test("compileM365SyncPattern anchors exact matches instead of regex substrings", () => {
	const pattern = compileM365SyncPattern("foo.md");

	expect(pattern.test("foo.md")).toBe(true);
	expect(pattern.test("fooXmd")).toBe(false);
	expect(pattern.test("prefix-foo.md")).toBe(false);
});

test("compileM365SyncPattern escapes regex metacharacters before glob expansion", () => {
	const bracketPattern = compileM365SyncPattern("[.git]");
	const parenPattern = compileM365SyncPattern("report(1).md");
	const wildcardPattern = compileM365SyncPattern("*.md");

	expect(bracketPattern.test("[.git]")).toBe(true);
	expect(bracketPattern.test("x.git")).toBe(false);
	expect(parenPattern.test("report(1).md")).toBe(true);
	expect(parenPattern.test("report11md")).toBe(false);
	expect(wildcardPattern.test("notes.md")).toBe(true);
	expect(wildcardPattern.test("notes.txt")).toBe(false);
});
