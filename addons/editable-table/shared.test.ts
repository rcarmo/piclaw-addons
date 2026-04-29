import { expect, test } from "bun:test";

import {
  normalizeMarkdownTable,
  parseMarkdownTable,
  serializeMarkdownTable,
  trimEmptyTrailingRows,
} from "./shared.ts";

test("parseMarkdownTable parses headers and rows", () => {
  const table = parseMarkdownTable(`| Name | Role |\n| --- | --- |\n| Rui | User |\n| Smith | Agent |`);
  expect(table).toEqual({
    headers: ["Name", "Role"],
    rows: [["Rui", "User"], ["Smith", "Agent"]],
  });
});

test("normalizeMarkdownTable pads short rows and emits canonical markdown", () => {
  expect(normalizeMarkdownTable(`| A | B |\n| --- | --- |\n| 1 |`)).toBe(`| A | B |\n| --- | --- |\n| 1 |  |`);
});

test("serializeMarkdownTable escapes pipes and preserves body rows", () => {
  expect(serializeMarkdownTable({
    headers: ["Name", "Notes"],
    rows: [["Rui", "a | b"]],
  })).toBe(`| Name | Notes |\n| --- | --- |\n| Rui | a \\| b |`);
});

test("trimEmptyTrailingRows removes only trailing blank rows", () => {
  expect(trimEmptyTrailingRows([["x"], [""], [" "]])).toEqual([["x"]]);
  expect(trimEmptyTrailingRows([["x"], [""], ["y"]])).toEqual([["x"], [""], ["y"]]);
});
