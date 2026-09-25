import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createAnchor, projectAnchor } from "./anchors.ts";
import { LIMITS, ReviewError } from "./contracts.ts";

describe("createAnchor", () => {
  test("builds a range anchor with digest, selected text, and bounded context", () => {
    const text = ["one", "two", "three", "four", "five", "six", "seven"].join(
      "\n",
    );

    const anchor = createAnchor("file-1", "source", text, {
      startLine: 4,
      endLine: 5,
    });

    expect(anchor).toEqual({
      snapshotFileId: "file-1",
      scope: "range",
      side: "source",
      startLine: 4,
      endLine: 5,
      blobSha256: sha256Utf8(text),
      selectedText: "four\nfive",
      contextBefore: ["one", "two", "three"],
      contextAfter: ["six", "seven"],
    });
  });

  test("creates file-scope anchors when no range is given", () => {
    const text = "alpha\nbeta\n";

    const anchor = createAnchor("file-2", "new", text);

    expect(anchor).toEqual({
      snapshotFileId: "file-2",
      scope: "file",
      side: "new",
      startLine: null,
      endLine: null,
      blobSha256: sha256Utf8(text),
      selectedText: "",
      contextBefore: [],
      contextAfter: [],
    });
  });

  test("preserves blank selected lines", () => {
    const text = ["alpha", "", "gamma"].join("\n");

    const anchor = createAnchor("file-3", "old", text, {
      startLine: 2,
      endLine: 2,
    });

    expect(anchor.selectedText).toBe("");
    expect(anchor.contextBefore).toEqual(["alpha"]);
    expect(anchor.contextAfter).toEqual(["gamma"]);
  });

  test("rejects invalid ranges", () => {
    const text = ["one", "two"].join("\n");

    for (const range of [
      { startLine: 0, endLine: 1 },
      { startLine: 1, endLine: 0 },
      { startLine: 2, endLine: 1 },
      { startLine: 1.5, endLine: 2 },
      { startLine: 1, endLine: 3 },
    ]) {
      expect(() =>
        createAnchor(
          "file-4",
          "source",
          text,
          range as { startLine: number; endLine: number },
        ),
      ).toThrow(ReviewError);
    }
  });

  test("rejects selections larger than 16 KiB of UTF-8 text", () => {
    const tooLarge = `${"😀".repeat(Math.floor(LIMITS.commentBytes / 4) + 1)}`;

    expect(() =>
      createAnchor("file-5", "source", tooLarge, { startLine: 1, endLine: 1 }),
    ).toThrow(ReviewError);
  });
});

describe("projectAnchor", () => {
  test("returns exact for an unchanged snapshot", () => {
    const text = ["one", "two", "three"].join("\n");
    const anchor = createAnchor("file-6", "source", text, {
      startLine: 2,
      endLine: 2,
    });

    expect(projectAnchor(anchor, text)).toEqual({
      status: "exact",
      startLine: 2,
      endLine: 2,
      method: "same-snapshot",
    });
  });

  test("CR-055 projects a unique unchanged block after unrelated inserted lines", () => {
    const original = [
      "head-1",
      "head-2",
      "ctx-a",
      "ctx-b",
      "ctx-c",
      "selected-1",
      "selected-2",
      "tail-a",
      "tail-b",
    ].join("\n");
    const anchor = createAnchor("file-7", "source", original, {
      startLine: 6,
      endLine: 7,
    });
    const refreshed = [
      "head-1",
      "insert-1",
      "insert-2",
      "insert-3",
      "insert-4",
      "insert-5",
      "head-2",
      "ctx-a",
      "ctx-b",
      "ctx-c",
      "selected-1",
      "selected-2",
      "tail-a",
      "tail-b",
    ].join("\n");

    expect(projectAnchor(anchor, refreshed)).toEqual({
      status: "moved",
      startLine: 11,
      endLine: 12,
      method: "unique-context",
    });
  });

  test("CR-056 returns missing when the selected block changed instead of reusing line numbers", () => {
    const original = [
      "pre-1",
      "pre-2",
      "pre-3",
      "keep-me",
      "keep-too",
      "post-1",
      "post-2",
    ].join("\n");
    const anchor = createAnchor("file-8", "source", original, {
      startLine: 4,
      endLine: 5,
    });
    const changed = [
      "pre-1",
      "pre-2",
      "pre-3",
      "new-code",
      "other-code",
      "post-1",
      "post-2",
    ].join("\n");

    expect(projectAnchor(anchor, changed)).toEqual({
      status: "missing",
      startLine: null,
      endLine: null,
      method: "unmapped",
    });
  });

  test("CR-057 reports ambiguity for equally plausible duplicate matches", () => {
    const original = ["fn a", "dup", "end"].join("\n");
    const anchor = createAnchor("file-9", "old", original, {
      startLine: 2,
      endLine: 2,
    });
    const changed = ["fn a", "dup", "end", "gap", "fn a", "dup", "end"].join(
      "\n",
    );

    expect(projectAnchor(anchor, changed)).toEqual({
      status: "ambiguous",
      startLine: null,
      endLine: null,
      method: "unmapped",
    });
  });

  test("uses neighbouring context to disambiguate duplicate selected text", () => {
    const original = [
      "ctx-a1",
      "ctx-a2",
      "ctx-a3",
      "dup",
      "ctx-b1",
      "ctx-b2",
    ].join("\n");
    const anchor = createAnchor("file-10", "new", original, {
      startLine: 4,
      endLine: 4,
    });
    const changed = [
      "x1",
      "x2",
      "x3",
      "dup",
      "y1",
      "y2",
      "ctx-a1",
      "ctx-a2",
      "ctx-a3",
      "dup",
      "ctx-b1",
      "ctx-b2",
    ].join("\n");

    expect(projectAnchor(anchor, changed)).toEqual({
      status: "moved",
      startLine: 10,
      endLine: 10,
      method: "unique-context",
    });
  });

  test("treats line ending changes, unicode, and empty selected lines as a moved match", () => {
    const original = ["prefix", "", "βeta", "tail", "Ω"].join("\r\n");
    const anchor = createAnchor("file-11", "source", original, {
      startLine: 2,
      endLine: 3,
    });
    const changed = ["inserted", "prefix", "", "βeta", "tail", "Ω"].join("\n");

    expect(projectAnchor(anchor, changed)).toEqual({
      status: "moved",
      startLine: 3,
      endLine: 4,
      method: "unique-context",
    });
  });

  test("returns missing when sameFile is false, even if bytes are identical", () => {
    const text = ["same", "bytes"].join("\n");
    const anchor = createAnchor("file-12", "source", text, {
      startLine: 1,
      endLine: 2,
    });

    expect(projectAnchor(anchor, text, { sameFile: false })).toEqual({
      status: "missing",
      startLine: null,
      endLine: null,
      method: "unmapped",
    });
  });

  test("file-scope anchors only project by exact same-file identity", () => {
    const original = ["alpha", "beta"].join("\n");
    const anchor = createAnchor("file-13", "source", original);
    const changed = ["alpha", "beta", "gamma"].join("\n");

    expect(projectAnchor(anchor, original)).toEqual({
      status: "exact",
      startLine: null,
      endLine: null,
      method: "same-snapshot",
    });
    expect(projectAnchor(anchor, changed)).toEqual({
      status: "missing",
      startLine: null,
      endLine: null,
      method: "unmapped",
    });
  });

  test("preserves the original anchor while producing later projections (CR-171)", () => {
    const original = ["ctx-1", "ctx-2", "ctx-3", "selected", "tail"].join("\n");
    const anchor = createAnchor("file-14", "old", original, {
      startLine: 4,
      endLine: 4,
    });
    const before = JSON.parse(JSON.stringify(anchor));

    const projection = projectAnchor(
      anchor,
      ["new-head", "ctx-1", "ctx-2", "ctx-3", "selected", "tail"].join("\n"),
    );

    expect(projection).toEqual({
      status: "moved",
      startLine: 5,
      endLine: 5,
      method: "unique-context",
    });
    expect(anchor).toEqual(before);
  });

  test("property: identical random documents always project exactly", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = lcg(seed);
      const lines = Array.from(
        { length: 1 + Math.floor(random() * 10) },
        (_, index) => randomLine(seed, index, random),
      );
      const separator = seed % 2 === 0 ? "\n" : "\r\n";
      const trailing = seed % 3 === 0 ? separator : "";
      const text = lines.join(separator) + trailing;
      const startLine = 1 + Math.floor(random() * lines.length);
      const endLine =
        startLine + Math.floor(random() * (lines.length - startLine + 1));
      const anchor = createAnchor(`prop-${seed}`, "source", text, {
        startLine,
        endLine,
      });

      expect(projectAnchor(anchor, text)).toEqual({
        status: "exact",
        startLine,
        endLine,
        method: "same-snapshot",
      });
    }
  });

  test("property: inserting unrelated lines before preserved context shifts the mapped range", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = lcg(seed * 17);
      const head = [`head-${seed}-a`, `head-${seed}-b`];
      const contextBefore = [
        `ctx-before-${seed}-1`,
        `ctx-before-${seed}-2`,
        `ctx-before-${seed}-3`,
      ];
      const selected = Array.from(
        { length: 1 + Math.floor(random() * 3) },
        (_, index) =>
          `selected-${seed}-${index}-${Math.floor(random() * 1_000)}`,
      );
      const contextAfter = [
        `ctx-after-${seed}-1`,
        `ctx-after-${seed}-2`,
        `ctx-after-${seed}-3`,
      ];
      const tail = [`tail-${seed}-a`];
      const originalLines = [
        ...head,
        ...contextBefore,
        ...selected,
        ...contextAfter,
        ...tail,
      ];
      const anchor = createAnchor(
        `prop-moved-${seed}`,
        "source",
        originalLines.join("\n"),
        {
          startLine: head.length + contextBefore.length + 1,
          endLine: head.length + contextBefore.length + selected.length,
        },
      );
      const inserted = Array.from(
        { length: 1 + Math.floor(random() * 5) },
        (_, index) => `inserted-${seed}-${index}`,
      );
      const refreshedLines = [head[0], ...inserted, ...originalLines.slice(1)];

      expect(projectAnchor(anchor, refreshedLines.join("\n"))).toEqual({
        status: "moved",
        startLine: anchor.startLine! + inserted.length,
        endLine: anchor.endLine! + inserted.length,
        method: "unique-context",
      });
    }
  });
});

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomLine(seed: number, index: number, random: () => number): string {
  const fragments = ["alpha", "βeta", "", "space value", "😀", "tail"];
  return `${seed}-${index}-${fragments[Math.floor(random() * fragments.length)]}-${Math.floor(random() * 10_000)}`;
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
