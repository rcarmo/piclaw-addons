import { expect, test } from "bun:test";

import {
  buildExportUrl,
  buildWkhtmltopdfArgs,
  parseCliArgs,
  resolveOutputPaths,
} from "./export-timeline-pdf.ts";

test("parseCliArgs validates bounded numeric options and theme", () => {
  expect(parseCliArgs(["--chat", "web:addons", "--last", "10", "--theme", "dark"])).toMatchObject({
    chatJid: "web:addons",
    lastN: "10",
    theme: "dark",
    outPath: "/workspace/exports/timeline-web_addons.pdf",
  });
  expect(() => parseCliArgs(["--last", "0"])).toThrow("--last must be a positive integer");
  expect(() => parseCliArgs(["--port", "abc"])).toThrow("--port must be a positive integer");
  expect(() => parseCliArgs(["--theme", "sepia"])).toThrow("--theme must be light or dark");
});

test("buildExportUrl encodes the requested timeline range", () => {
  const options = parseCliArgs([
    "--chat", "web:addons",
    "--from", "2026-07-01T00:00:00Z",
    "--to", "2026-07-02T00:00:00Z",
    "--from-row", "10",
    "--to-row", "20",
    "--last", "5",
    "--theme", "dark",
  ]);
  const url = buildExportUrl(8080, options);
  expect(url).toContain("http://127.0.0.1:8080/internal/export/timeline?");
  expect(url).toContain("chat_jid=web%3Aaddons");
  expect(url).toContain("from=2026-07-01T00%3A00%3A00Z");
  expect(url).toContain("to=2026-07-02T00%3A00%3A00Z");
  expect(url).toContain("from_row=10");
  expect(url).toContain("to_row=20");
  expect(url).toContain("last=5");
  expect(url).toContain("theme=dark");
});

test("resolveOutputPaths derives the HTML sidecar next to the PDF", () => {
  expect(resolveOutputPaths("/workspace/exports/timeline.pdf")).toEqual({
    outPath: "/workspace/exports/timeline.pdf",
    htmlPath: "/workspace/exports/timeline.html",
    outDir: "/workspace/exports",
  });
  expect(resolveOutputPaths("/workspace/exports/timeline")).toEqual({
    outPath: "/workspace/exports/timeline",
    htmlPath: "/workspace/exports/timeline.html",
    outDir: "/workspace/exports",
  });
});

test("wkhtmltopdf renders the local HTML sidecar without auth headers", () => {
  const args = buildWkhtmltopdfArgs("/workspace/exports/timeline.html", "/workspace/exports/timeline.pdf");
  expect(args).toContain("--enable-local-file-access");
  expect(args).toContain("file:///workspace/exports/timeline.html");
  expect(args).toContain("/workspace/exports/timeline.pdf");
  expect(args).not.toContain("--custom-header");
  expect(args.join(" ")).not.toContain("Authorization");
  expect(args.join(" ")).not.toContain("Bearer");
});
