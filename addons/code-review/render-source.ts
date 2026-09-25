import { diffLines } from "diff";
import {
  highlightTree,
  classHighlighter,
  tagHighlighter,
  tags,
} from "@lezer/highlight";
import { parser as javascript } from "@lezer/javascript";
import { parser as markdown } from "@lezer/markdown";
import { parser as json } from "@lezer/json";
import { parser as python } from "@lezer/python";
import { LIMITS, ReviewError } from "./contracts.js";
import { hashText } from "./validation.js";
export interface CodeLine {
  number: number;
  text: string;
  html: string;
}
export interface DiffRow {
  kind: "context" | "added" | "deleted";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}
export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const functionRoles = tagHighlighter([
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    class: "tok-function",
  },
]);
const highlighter = {
  style(active: any) {
    return (
      [classHighlighter.style(active), functionRoles.style(active)]
        .filter(Boolean)
        .join(" ") || null
    );
  },
};
export function sourceLines(text: string): string[] {
  const result = text.split(/\r\n|\n|\r/);
  if (result.length > 1 && /[\r\n]$/.test(text)) result.pop();
  return result;
}
export function languageFor(path: string): string {
  const ext = path.split(".").at(-1)?.toLowerCase();
  return (
    (
      {
        ts: "typescript",
        tsx: "tsx",
        js: "javascript",
        mjs: "javascript",
        cjs: "javascript",
        jsx: "jsx",
        md: "markdown",
        mdx: "markdown",
        json: "json",
        py: "python",
      } as Record<string, string>
    )[ext ?? ""] ?? "text"
  );
}
const tokenCache = new Map<
  string,
  { language: string; highlighted: boolean; lines: CodeLine[] }
>();
const copyHighlight = (value: { language: string; highlighted: boolean; lines: CodeLine[] }) =>
  ({ ...value, lines: value.lines.map((line) => ({ ...line })) });
function highlightSourceCached(path: string, text: string) {
  const language = languageFor(path),
    cacheKey = `${language}:v1:${hashText(text)}`;
  const hit = tokenCache.get(cacheKey);
  if (hit) return hit;
  const rawLines = sourceLines(text),
    lines = rawLines.map((line, index) => ({
      number: index + 1,
      text: line,
      html: escapeHtml(line),
    }));
  const result = { language, highlighted: false, lines };
  if (
    Buffer.byteLength(text) > 96 * 1024 ||
    rawLines.length > 2500 ||
    language === "text"
  )
    return result;
  const parser =
    language === "typescript"
      ? javascript.configure({ dialect: "ts" })
      : language === "tsx"
        ? javascript.configure({ dialect: "ts jsx" })
        : language === "jsx"
          ? javascript.configure({ dialect: "jsx" })
          : language === "javascript"
            ? javascript
            : language === "markdown"
              ? markdown
              : language === "json"
                ? json
                : python;
  try {
    const tokens: Array<{ from: number; to: number; cls: string }> = [];
    highlightTree(parser.parse(text), highlighter, (from, to, cls) =>
      tokens.push({ from, to, cls }),
    );
    let start = 0,
      index = 0;
    for (const line of lines) {
      const end = start + line.text.length;
      while (index < tokens.length && tokens[index]!.to <= start) index++;
      let cursor = start,
        html = "";
      for (let n = index; n < tokens.length && tokens[n]!.from < end; n++) {
        const t = tokens[n]!,
          from = Math.max(cursor, start, t.from),
          to = Math.min(end, t.to);
        if (to <= from) continue;
        html +=
          escapeHtml(text.slice(cursor, from)) +
          `<span class="${escapeHtml(t.cls)}">${escapeHtml(text.slice(from, to))}</span>`;
        cursor = to;
      }
      line.html = html + escapeHtml(text.slice(cursor, end));
      start = end + (text.slice(end, end + 2) === "\r\n" ? 2 : 1);
    }
    result.highlighted = true;
  } catch {
    return {
      language,
      highlighted: false,
      lines: rawLines.map((line, index) => ({
        number: index + 1,
        text: line,
        html: escapeHtml(line),
      })),
    };
  }
  if (tokenCache.size >= 16) tokenCache.delete(tokenCache.keys().next().value!);
  tokenCache.set(cacheKey, result);
  return result;
}
export function highlightSource(path: string, text: string) {
  return copyHighlight(highlightSourceCached(path, text));
}
// Large/unsupported source never needs full-file HTML for a bounded page.
// Keep line coordinates from the complete immutable snapshot, escape only selected rows.
export function highlightSourcePage(
  path: string,
  text: string,
  offset: number,
  limit: number,
  selectedLines?: Set<number | null>,
) {
  const language = languageFor(path);
  const raw = sourceLines(text);
  if (Buffer.byteLength(text) <= 96 * 1024 && raw.length <= 2500 && language !== "text") {
    const result = highlightSourceCached(path, text);
    const page = selectedLines ? result.lines.filter((line) => selectedLines.has(line.number)) : result.lines.slice(offset, offset + limit);
    return { ...result, total: result.lines.length, lines: page.map((line) => ({ ...line })) };
  }
  const lines: CodeLine[] = [];
  if (selectedLines) {
    for (const number of selectedLines) {
      if (number === null || number < 1 || number > raw.length) continue;
      const value = raw[number - 1]!;
      lines.push({ number, text: value, html: escapeHtml(value) });
    }
    lines.sort((a, b) => a.number - b.number);
  } else for (let index = Math.min(offset, raw.length); index < Math.min(raw.length, offset + limit); index++) {
    const value = raw[index]!;
    lines.push({ number: index + 1, text: value, html: escapeHtml(value) });
  }
  return { language, highlighted: false, total: raw.length, lines };
}
export function compareSource(
  oldText: string | null,
  newText: string | null,
): DiffRow[] {
  const a = oldText ?? "",
    b = newText ?? "";
  if (Buffer.byteLength(a) + Buffer.byteLength(b) > LIMITS.captureBytes)
    throw new ReviewError("limit", "Diff input exceeds limit.");
  const parts = diffLines(a, b, {
    timeout: 1000,
    maxEditLength: LIMITS.diffLines,
  });
  if (!parts)
    throw new ReviewError("limit", "Diff exceeds computation budget.");
  const rows: DiffRow[] = [];
  let oldLine = 1,
    newLine = 1,
    changed = 0;
  for (const part of parts) {
    if (!part.value) continue;
    const lines = sourceLines(part.value);
    if (part.added || part.removed) changed += lines.length;
    if (changed > LIMITS.diffLines)
      throw new ReviewError("limit", "Diff exceeds changed-line limit.");
    for (const line of lines)
      rows.push({
        kind: part.added ? "added" : part.removed ? "deleted" : "context",
        oldLine: part.added ? null : oldLine++,
        newLine: part.removed ? null : newLine++,
        text: line,
      });
  }
  return rows;
}
