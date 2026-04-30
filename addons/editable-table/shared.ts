export type MarkdownTable = {
  headers: string[];
  rows: string[][];
};

function trimOuterPipe(line: string): string {
  let value = String(line || "").trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value;
}

function splitMarkdownRow(line: string): string[] {
  return trimOuterPipe(line)
    .split("|")
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function escapeMarkdownCell(value: string): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

export function parseMarkdownTable(markdown: string): MarkdownTable {
  const lines = String(markdown || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("Provide a Markdown table with a header row and separator row.");
  }

  const headers = splitMarkdownRow(lines[0]);
  const separator = splitMarkdownRow(lines[1]);

  if (!headers.length || headers.every((cell) => !cell.trim())) {
    throw new Error("The Markdown table must include at least one header column.");
  }

  if (separator.length < headers.length || !separator.slice(0, headers.length).every(isSeparatorCell)) {
    throw new Error("The second row must be a Markdown separator like | --- | --- |.");
  }

  const width = headers.length;
  const normalizedHeaders = headers.slice(0, width).map((cell, index) => cell || `Column ${index + 1}`);
  const rows = lines.slice(2).map((line) => {
    const cells = splitMarkdownRow(line);
    return Array.from({ length: width }, (_unused, index) => cells[index] ?? "");
  });

  return { headers: normalizedHeaders, rows };
}

export function normalizeMarkdownTable(markdown: string): string {
  const table = parseMarkdownTable(markdown);
  return serializeMarkdownTable(table);
}

export function serializeMarkdownTable(table: MarkdownTable): string {
  const width = Math.max(
    1,
    table.headers.length,
    ...table.rows.map((row) => row.length),
  );
  const headers = Array.from({ length: width }, (_unused, index) => table.headers[index] ?? `Column ${index + 1}`);
  const rows = table.rows.map((row) => Array.from({ length: width }, (_unused, index) => row[index] ?? ""));

  const headerLine = `| ${headers.map(escapeMarkdownCell).join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`);

  return [headerLine, separatorLine, ...bodyLines].join("\n");
}

export function trimEmptyTrailingRows(rows: string[][]): string[][] {
  const next = rows.map((row) => [...row]);
  while (next.length > 0 && next[next.length - 1].every((cell) => !String(cell || "").trim())) {
    next.pop();
  }
  return next;
}
